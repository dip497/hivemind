# The daemon's screens off its I/O thread

Status: accepted, 2026-10-17. Replaces the proposal of the same name from earlier today.

## Verdict

Move every headless terminal into **one screen worker** (a `worker_threads` thread in the daemon's
process). The main thread keeps the PTYs, the clients, the byte ring and a copy of each session's
modes. A screen is asked for at an output position; main **pins the ring** at that position until
the answer arrives and appends the ring's bytes after it, so every screen is exact without a retry.
**A session 256 K chars behind the worker has its PTY paused** until it is 64 K behind: that
bounds the memory a flood can queue, and it only ever pauses the session that printed too much.

The proposal's pool (C) and its per-session router are dropped: measured agent output is 1000×
below one worker's parse rate.

## Problem

**Goal.** No terminal waits for another terminal's screen work: a keystroke's echo and a session's
output reach their viewers however much another session prints, and however many screens are
being taken.

**Done when.** A daemon test floods one session with 50 MB while another echoes keys, and the echo
stays under 50 ms (median; the tail is stated with the machine's load); the daemon and endpoint
suites pass; `show30`'s worst main-thread stall drops from the whole run to a few ms.

**Constraints.**
- node-pty is not thread safe (its README). The PTYs stay on the thread that made them.
- The replay every client draws (desktop xterm.js, phone, `hive attach`) stays what
  `@xterm/addon-serialize` produces.
- The daemon runs under three runtimes: Electron-as-node (bundled by electron-vite), bun from
  source (`hive daemon start` in development), and the compiled `hive` (Linux only today). A
  worker has to load in all three.
- App, `hive host` and daemon ship as one release; the protocol may change.

### Real numbers (machine: 16 CPUs; load is stated per number because it was 60–105 all day)

| What | Number | Source |
|---|---|---|
| Live agent output, all sessions | **5.9 KB/s total** for 36 sessions (5 busy) over 60 s | `/proc/<release daemon>/io` rchar delta; includes socket reads, so an upper bound |
| Busiest agent process | 4.5 MB/s rchar, 88 KB/s wchar | `/proc/<pid>/io`; its writes go to files and the pty together |
| Echo under a 50 MB flood, today | p50 22 ms, p90 64, p99 272, **max 1929 ms**; flood 0.84 MB/s | `echo-flood.mts`, real daemon, load 66 |
| Echo under a 20 MB flood, today | p50 27, p90 62, p99 389, max 669 ms | same, load 62, profiled |
| Daemon thread during that flood | parse 26%, serialize 12% (the 2 s disk snapshot), socket writes 8%, GC 4.5%, idle 25% | `--cpu-prof` of the daemon |
| Parse rate in a worker | 1.6 MB/s Electron-as-node, 1.7 node, 1.9 bun (load 70–75); 4.7 MB/s at load 26 | `probe.mjs` |
| Serialize 1000 lines × 160 cols in a worker | 500–650 ms at load 70; 83 ms at load 40 | `probe.mjs`, earlier `worker-cost.ts` |
| Main-thread stall while the worker parses 2.6 MB and serializes | 32–66 ms worst timer lag, which is the machine's noise at that load | `probe.mjs` |
| 30 screens at 1000 lines, today | 11.7 s at load 72, 29.7 s at load 105, **all of it one main-thread stall** | `show30.mts` |
| Worker message cost | 48 MB/s of 16 KB strings, 10× the parse rate | `worker-cost.ts` |

**What runs on the daemon's one thread today** (`pty-session-manager.ts`, `pty-daemon.ts`): parsing
every byte into a headless xterm, serializing screens (attach, `screen`, resync, the 2 s disk save,
detach, exit), reading the visible rows for status every 1.2 s, and reading bracketed paste, mouse
encoding and the title from the xterm.

**The known problem.** A producer/consumer split: a fast I/O loop feeding a slow interpreter, with
occasional large reads of the interpreter's state. The I/O side must never wait on the
interpreter, and the queue between them needs a bound that pushes back on the producer.

**The surprise.** The proposal sized the worker for throughput (20 KB/s per session, 13% of a core
at 30 sessions, a pool at 300). Measured, all 36 live sessions together print 5.9 KB/s: one worker
has three orders of magnitude of headroom. The problem is only **latency and isolation**: a flood
or a serialize holding the one thread for hundreds of ms to seconds. That changes the design: no
pool, no router; the worker's job is to be the place where slow work may be slow.

## What others do

- **VS Code's pty host** keeps one `@xterm/headless` per terminal on the same thread as node-pty
  (`src/vs/platform/terminal/node/ptyService.ts` L788-797, L1036-1071), writes to it with no callback
  and no back-pressure (only xterm's 50 MB discard limit, `WriteBuffer.ts` L20), and serializes
  `persistentSessionScrollback` lines, **100 by default** (`terminalPlatformConfiguration.ts`
  L401-405). Its flow control is host↔window only: pause above 100 K unacked chars, resume below 5 K
  (`common/terminal.ts` L881-902). Teaches: the same design as ours, with the same cost.
- **VS Code issue #338148** (open, 2026-09-26), "Pty host parses all terminal output a second time":
  under load the pty host thread was 44% busy, 33 points of it headless parse; turning persistence
  off did not help. Teaches: the parse must leave the I/O thread; nobody upstream has done it yet.
- **Zellij**: a pty thread reads 64 KiB per pane and sends to one screen thread that parses every
  pane, over a channel bounded at 50 messages (`zellij-server/src/lib.rs` L5074-5130,
  `terminal_bytes.rs` L13). [poor.dev/blog/performance](https://poor.dev/blog/performance/): the
  unbounded channel overflowed under `cat`; bounding it halved the time (19.2 s → 9.7 s for 2 M
  lines). Teaches: one parser thread for all panes is enough, and the bound is what makes it work.
- **WezTerm's mux**: two threads per pane, a reader and a parser, joined by a socketpair with a 1 MiB
  buffer whose blocking write is the back-pressure (`mux/src/lib.rs` L268-337); attach sends dirty
  rows and lines, not a VT replay (`sessionhandler.rs` L91-146). Teaches: back-pressure by a bounded
  buffer per pane; a thread per pane is a native-thread luxury a JS isolate per session cannot afford.
- **tmux** parses every pane in its one event loop but reads each pane about once per loop turn
  (`window.c` L1699-1724, `server-client.c` L2067), and redraws only the visible screen on attach.
  Teaches: fairness per pane; small attach screens. A C parser makes one thread affordable; ours is
  10-30× slower.
- **node-pty README** L121-123: "not thread safe"; maintainer advice in #405 is to keep it out of a
  busy event loop. Teaches: the PTYs stay on main; the parse is what moves.
- **Others with headless xterm**: agent-code #764 measured 35 headless terminals on Electron main at
  1.65 s worst event-loop delay and proposes a separate process; kolu #2172 replaced
  `@xterm/headless` with a wasm VT engine; xterm.js maintainers say the JS parser hit hard limits
  (#5686). Teaches: the problem is common; a native engine is where the ecosystem is heading (E).
- **Native parse rates** (kitty's benchmark, rendering off, MB/s): alacritty 32-47, wezterm 11-26,
  kitty 60-122 (sw.kovidgoyal.net/kitty/performance). xterm.js's full chain: 15-30 MB/s on a fast
  machine (#3515). Ours measured 1.6-4.7 MB/s at load 26-75 with serialize-friendly options.

## Options

**A. Stay on one thread, bounded (today).**

```
pty ─► main: boundary cut, ring, clients, headless xterm (parse, serialize, viewport)
```

Every serialize and every parse slice sits between a keystroke and its echo. Breaks first where a
serialize lands: a flood's 2 s disk save, any attach of a busy session.

**B. One screen worker, the ring as the bound (chosen).**

```
            ┌──────────────────── main thread ────────────────────┐
pty ─read─► │ cut at sequence end ─► ring (256 K, pinned) ─► clients│
            │        │                   ▲                         │
            │        └─(chunk, end)──────┼──────► worker: xterm per session
            │  modes copy ◄──(paste, title, mouse, parsed-up-to)───┤   parse, serialize,
            │  pause pty while unparsed ≥ 256 K chars              │   visible rows
            └──────────────────────────────────────────────────────┘
screen = worker.serialize() @ at  +  ring after at   (exact: the ring keeps at until the answer)
```

Main forwards each chunk to clients first and to the worker second. The worker answers
`screen(id, lines)` and `rows(ids)`, each in turn behind that session's pending output, and pushes
changes of a session's bracketed paste and title, plus how far it has parsed. Breaks first when
total output passes one core's parse rate (1.6–4.7 MB/s): the noisiest PTYs are paused, which is the
tmux behaviour, and their screens stay exact.

**B′. Parse only when a screen is asked for** (the fix proposed in VS Code #338148): keep raw output
and parse it when a serialize is needed. Status reads every agent's visible rows every 1.2 s, so
agent sessions would parse continuously anyway, and the backlog of a quiet shell is unbounded
without a cap that forces a parse. It moves the cost; it does not move it off the thread.

**C. A pool of k workers, sessions sharded.** Same messages as B over k threads. Breaks on memory
per isolate and on a single session that outprints one core.

**D. A screen process** (VS Code's pty-host split, inverted: the PTYs stay, the terminals move to a
child process). Same messages as B over a pipe. Isolates a crash in native code, which the screens
have none of (xterm.js is pure JS), and adds a second process to start, find, version and restart
in three runtimes.

**E. A native VT engine on main** (alacritty's, already in `crates/hive-phone`, as a napi module).
Parses an order of magnitude faster (unmeasured here), but the serializer has to be rewritten to
match what every client draws, it needs a native build for four targets, and a serialize of 1000
lines would still run on the I/O thread. It is the upgrade for parse throughput, and B's worker is
where it would plug in.

### Scale

Today: 36 sessions, 5.9 KB/s total. 10×: 360 sessions (`hive host` serving guests). 100×: 3600.

| Design | Today (36) | 10× (360) | 100× (3600) |
|---|---|---|---|
| A | Breaks now: one flood or one serialize stalls every echo for 0.3–2 s | Breaks | Breaks |
| B | Holds: parse 5.9 KB/s of 1.6–4.7 MB/s; main never serializes | Holds: 59 KB/s parse; 300 attaches = 25 s of the worker, screens arrive one by one, main free | Breaks on memory (133 GB), not on CPU |
| C (k=4) | Holds, +3 isolates idle | Holds, attaches 6 s | Breaks on memory |
| D | Holds | Holds | Breaks on memory |
| E | Serialize still on main | Breaks on serialize stalls | Breaks |

Arithmetic:
- Parse demand: 5.9 KB/s measured for 36 sessions → 59 KB/s at 10×, 590 KB/s at 100×; one worker
  parses 1.6 MB/s at load 70, 4.7 at load 26. CPU is not the limit at any row.
- Attaches: 1000-line serialize 83 ms (load 40) × 300 = 25 s; with 4 workers 6.2 s.
- Memory: about 37 MB per session at 6000 lines × 160 columns (1.1 GB / 30, measured) → 13 GB at
  360, 133 GB at 3600. Memory bounds 100× in every design; the lever is a smaller kept scrollback
  per idle session, or ending idle sessions (the sleep track).
- Queue bound: at most 256 K chars unparsed per session (the hold) plus one read = 512 KB of UTF-16
  per flooding session; 36 floods at once would hold 18 MB. A quiet or agent session holds nothing.

## Choice

**B.** It removes every stall from the I/O thread with one worker and one rule.

- A lost: the stalls are the problem.
- C lost: it buys throughput that is 1000× more than measured demand, for 3 more isolates of
  memory. B's messages already name the session, so a pool stays a mechanical change.
- D lost: a process gives crash isolation for native code the screens do not have, at the price
  of process lifecycle in three runtimes.
- E lost for now: it moves the bottleneck it does not have (parse) and keeps the one it does
  (serialize on the I/O thread).

**Why the ring is pinned, and the hold is the ring's size.** Today a screen waits for the xterm to
drain to `at`, then appends ring bytes after `at`, and retries three times when a flood outran the
ring. Here main records `at` when it asks, and the ring keeps every chunk after the oldest pinned
`at` until the answer arrives, so a screen is exact however far the worker is behind. The hold is a
separate bound: a session 256 K chars behind is paused until it is 64 K behind.

The review asked for a larger hold (4 M chars) so that bursts pass at pty speed instead of the
worker's parse rate. Measured, it cost more than it gave. A screen carries everything printed while
it was waited for, so with a 4 M hold every screen of a flooding session was 4.7 M chars, framed as
JSON on the I/O thread; another window's echo then waited up to 1.7 s (`daemon-flood-echo`, 3 runs
each, load 24–30: 4 M hold median 24–67 ms, worst 180–1714 ms; 256 K hold median 0.6–1.4 ms, worst
8–65 ms). A burst paced at the worker's 1.6–4.7 MB/s loses nothing a viewer would see: a window's
own terminal parses its bytes no faster.

**Screens, resizes and rows keep their place.** The worker runs each of them in turn behind the
session's pending output (an empty write's callback), as today's drain does. A first build that
serialized at once let a resize overtake pending output; the screen-replay test caught it.

**Modes as data.** `write` with `paste` needs "is bracketed paste on" synchronously, and a replay
needs the title. The worker pushes each change; main keeps them on the session. They lag the bytes
by the unparsed queue, as they lag the xterm's write buffer today. The mouse encoding comes with
each screen, read in the same turn, and goes between the screen and the ring's tail.

**The interface** (`screen-messages.ts`), all the worker does: `open` (with a seed: a saved screen,
or the ring after a restart), `write` (a chunk and its end position), `resize`, `screen`, `rows`,
`close`; it pushes `parsed`, `paste` and `title`. The sleep track's daemon messages ride on it:
`sleep(id)` takes the full screen through `screen` before `close`, the `slept` exit is main's, and a
frozen session's `saved` screen is read from its file on main, never from the worker.

**The worker's file.** Each runtime finds `screen-worker.js` next to the code that starts it: the
electron-vite build gets a third entry beside `pty-daemon.js`; the compiled `hive` passes the
worker as a second entry point with flat names (`/$bunfs/root/screen-worker.js`, checked); source
runs (tests, `bun` from source) use `screen-worker.ts`. Run from source under node, a worker gets
Node's own type stripping and no loader that maps `./x.js` to `./x.ts`, so the worker imports only
packages and types.

## Pre-mortem

It is a year later and B failed. The likely reasons, and what changed:

1. **The worker died and every screen went with it.** An exception or an out-of-memory in the
   worker ends it; the PTYs live on. Change: main restarts it and reopens each live session from
   its ring (the last 256 K chars) and asks its program to repaint; the log names each session
   whose screen lost history. A worker that dies within a minute of starting waits twice as long
   before the next start (1 s up to 60 s), so a worker that cannot load does not spin; meanwhile
   bytes flow and a screen is the ring's output, logged. The new terminal is seeded with the
   bracketed paste mode main keeps, which may have been set before what the ring holds. Ceiling:
   a crash loses scrollback older than the ring, and modes set before it other than paste. Not
   tested: nothing outside the worker can end it, and a test seam is against this repo's rules.
2. **A paused flood never resumed.** The worker's progress message is what resumes a PTY. If one
   is lost (a worker restart), the PTY stays paused. Change: a worker's death clears every hold at
   once, and no hold is taken while it is down; the hold is its own flag, never mixed with
   viewers' pauses (`interacts` clears those).
3. **A paste lost its brackets.** An app that turns bracketed paste on and is pasted into within
   the same unparsed window gets the text unbracketed. Same race as today's write buffer, but the
   window is now up to half a ring. A starter that waits for the agent's screen (agent-start.ts)
   is safe: the flag is pushed before the rows it waited for. Ceiling: an agent turns it on at start, seconds before any paste;
   if a case appears, the boundary scanner on main can watch `?2004h/l` itself.

4. **A request never answered, and shutdown hung on it.** Found while building: closing a terminal
   with a screen request queued in its write turn dropped the request, and `flushAll` would have
   waited forever. Change: a terminal's end runs in turn too, after everything asked before it;
   a dead worker answers every pending request with "no screen".

5. **A paused program's last words were lost.** Found while building: node-pty destroys a paused
   pty's socket 200 ms after its program exits, so a flood that ends while held loses its last
   output, and its viewer never sees how it ended. Change: while a pty is paused, main checks every
   50 ms whether its program is still alive and resumes it when it is not, so the rest is read
   before the socket goes. A daemon test pauses a session whose program prints and exits.
6. **A reused id took another session's messages.** A session killed and started again under the
   same id would get the old one's `parsed`, `paste` and `title`, and the review found the old
   program's last output, still read after the kill, drawn into the new one's screen. Change:
   each session instance has an epoch; every message to the worker about a session carries it and
   the worker acts only for the instance it holds, and every push carries it and main drops one
   whose epoch is not the live session's.

7. **A stop lost the last output.** Found while building: a save waits for its screen now, and
   `flushAll` waited only for the saves it started itself. A viewer leaving starts a save; a stop
   right after found nothing unsaved and exited with that save still waiting for its screen.
   Change: the manager keeps every save in flight, of ended sessions too, and a stop waits for all
   of them. A daemon test stops it as its viewer leaves.

8. **A sleep was saved as an end.** Found in review: a program that ends on its own while its
   screens at sleep are being taken was saved without its sleep mark, so a restarted daemon
   started it without a wake. The wait is longer with a worker. Change: the save made as a
   sleeping session ends is marked asleep whether or not those screens arrived.

**What a screen now costs.** One round trip to the worker. Measured against the old code in the same
minute (`lat.mts`, an idle 80×24 session, 30 screens × 4 runs each, load 88–91 on 16 CPUs): old
p50 32 ms, p90 103; new p50 60 ms, p90 172. Both are the scheduler at five times more runnable
threads than CPUs (the screen itself serializes in under 5 ms); the new path waits for two thread
wake-ups instead of none. The first screen after the daemon starts waits for the worker to load:
0.8–1.5 s under bun from source at load 90, 2.05 s in the built daemon at load 77. The daemon now
opens its socket sooner, because the main thread no longer loads xterm: socket + first screen is
2.00 + 2.05 = 4.05 s, against 4.95 + 0.08 = 5.03 s before (built daemon, `built.mjs`, load 77).
Only a screen asked for in the first seconds of a new daemon waits; a new session's first replay
is its saved screen, taken on main.

**Known ceiling.** One worker parses 1.6–4.7 MB/s. When measured total output passes half of that,
add workers (C). When one session alone passes it, E inside the worker.

## Build order

1. **The worker and its messages.** `screen-worker.ts` owns an xterm per session: open, write
   (with its end position), resize, screen, rows, close; pushes modes, title and parsed position.
   `SessionManager` talks to it and keeps no xterm. Check: the manager and daemon suites pass;
   paste, replay-modes and screen-replay tests pass.
2. **A pinned ring and a memory hold.** Pin the ring at each screen's position until it arrives;
   pause the PTY at 256 K chars behind, resume at 64 K; resume a paused pty whose program ended.
   Check: a test floods a session and its screen still matches what a terminal fed every byte
   draws; a paused session's last output reaches its viewer.
3. **Every runtime finds the worker.** electron-vite entry, compiled `hive` entry. Check: the
   built daemon runs a session (`pnpm build` + a daemon test against `out/main`), and
   `apps/cli/tests/sessions.test.ts` against a compiled `hive`.
4. **Restart.** Check: kill the worker mid-flood; every session's next screen arrives and the log
   names the gap.
5. **Measure.** `echo-flood` and `show30` before and after at stated load, in the commit and the
   changelog line.

## Unknown

- **Parse rate on a quiet machine.** Load never went under 60 today. Check: rerun `probe.mjs` at
  load under 2.
- **A wasm VT engine** (alacritty's from `hive-phone`, or ghostty's as kolu did) inside the worker,
  for option E. Check: a bench over the same bytes in
  `crates/hive-phone`.
- **How long the worker takes to start on a quiet machine.** Measured 2.05 s in the built daemon at
  load 77; it should be well under a second at low load. Check: `built.mjs` at load under 2.
- **Output rates over a day.** 5.9 KB/s is one minute of today's sessions. Check: log rchar of the
  daemon hourly for a day.
