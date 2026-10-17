# The daemon's screens off its I/O thread

Status: proposed, 2026-10-17. Not built.

## Verdict

Move every headless terminal out of the daemon's main thread into **one screen worker**. The main
thread keeps the PTYs, the clients and the byte ring. The worker parses, serializes, reads
viewports and reports modes. Route by session from day one, so a second worker is a config
change. A native VT engine is the upgrade for when parse throughput is what bites, not now.

## Problem

**Goal.** No terminal waits for another terminal's screen work: a keystroke's echo and a session's
output reach their viewers however much another session prints, or however many screens are being
rebuilt.

**Constraints.**
- node-pty is not thread safe (its README). The PTYs stay on the thread that made them.
- The replay a client gets must stay what `@xterm/serialize` produces today. Every client (desktop,
  phone, `hive attach`) draws it.
- The app, `hive host` and the daemon ship as one release. The protocol may change.

**What runs on the daemon's one thread today** (`pty-session-manager.ts`, `pty-daemon.ts`):

| Work | When | Cost (measured) |
|---|---|---|
| Parse every byte into a headless xterm | always | 4.7 MB/s on one core, for all sessions together |
| Serialize a screen | attach, show, save, `screen` | 474 ms at 5000 lines, 83 ms at 1000, 2 ms for the visible rows |
| Read the visible rows (`viewport`) | every 1.2 s per agent session, `viewport` requests | small |
| Bracketed-paste flag | every pasted message | read from the xterm |
| Mouse encoding, title | replay, title change | read from the xterm |

Serialize is synchronous. Parsing yields every slice but competes for the same thread.

**Numbers.** 30 sessions of 6000 lines at 160 columns: all screens at once took 15.8 s of the
thread at 5000 lines of scrollback and 4.2 s at 1000 (load about 40, so inflated). RSS was about
1.1 GB for those 30 headless terminals. Machine: 16 CPUs. The bench is
`$S/bench/show30.ts` and `$S/bench/worker-cost.ts` in the session scratchpad.

**Already bounded this round.** A periodic save keeps 500 lines. A window opens with 1000 lines
and fetches the rest on scroll. A terminal shown again gets the bytes it missed, not a screen.
These cut the stalls by 4–5×. They do not change who does the work.

**The known problem.** This is a producer/consumer split: a fast I/O loop feeding a slow
interpreter, with occasional large reads of the interpreter's state. It is Zellij's pty thread and
screen thread, and VS Code's pty host.

## What others do

- **Zellij**: a PTY thread reads every pane and sends bytes to a screen thread, which parses them.
  An unbounded channel between them grew without limit under `cat bigfile`. A bounded channel of
  50 messages fixed it: the PTY thread waits, and so does the program. Lesson: the queue to the
  parser needs a bound, and the bound is back-pressure on the PTY.
  ([poor.dev/blog/performance](https://poor.dev/blog/performance/))
- **VS Code**: the PTYs live in a separate pty-host process, because node-pty crashes took down the
  window and fast programs flooded its event loop. It has flow control between the pty host and the
  window. Lesson: isolation was for both stability and throughput, and the flow control is part of
  the design. ([Zed RFC #50584](https://github.com/zed-industries/zed/discussions/50584))
- **tmux**: one server owns every PTY, and on attach it redraws only the visible screen. Lesson:
  sending only what is visible on attach is the cheap default. We now do that within 1000 lines.
- **node-pty**: "not thread safe", so a pool of worker threads each holding PTYs is out.
  ([README](https://github.com/microsoft/node-pty#thread-safety))
- **Here**: `crates/hive-phone` already runs alacritty's VT emulator over a session's bytes, native
  and as wasm. It is the engine for option D.

## Options

**A. Stay on one thread, bounded (today).**

```
pty ─► main: ring + clients + headless xterm (parse, serialize, viewport)
```

Breaks first where a serialize lands: an attach or save holds every session for 83 ms at 1000 lines.

**B. One screen worker.**

```
pty ─► main: ring, clients, pause/resume ──(bytes, bounded)──► worker: xterms
                  ▲                                               │
                  └──── screens, viewports, modes, titles ◄──────┘
```

Main forwards each batch to clients first and to the worker second. The worker answers
`serialize(id, lines, at)`, `viewport(id)` and pushes mode and title changes. Main keeps a copy of
each session's bracketed-paste and mouse flags, so a write never waits for the worker. Breaks first
when total parse demand passes about 4.7 MB/s: the worker falls behind, and the bound pauses the
noisiest PTY.

**C. A worker pool, sessions sharded.** Same messages as B, with `k` workers and a session routed by
hash. Breaks when one session alone prints faster than a core parses.

**D. A native engine.** Replace `@xterm/headless` with alacritty's (already in `hive-phone`) as a
napi module or wasm in the worker, and write the screen-to-VT serializer in Rust. Breaks on
correctness: every replay must match what xterm.js draws.

### Scale

Today: 30 sessions, mostly agents printing in bursts. 10×: 300 sessions (`hive host` serving
guests). 100×: 3000 (not one machine's job).

| Design | Today (30) | 10× (300) | 100× (3000) |
|---|---|---|---|
| A | Holds. A 1000-line serialize stalls all for 83 ms | Breaks: 300 attaches take 25 s of the thread | Breaks |
| B | Holds. I/O never waits on screens | Holds while the total stays under 4.7 MB/s; 300 attaches take 25 s of the worker, none of main | Breaks on parse |
| C (k=4) | Holds | Holds: 4 × 4.7 = 19 MB/s; attaches 6 s | Breaks on parse and memory |
| D | Holds | Holds: parse 10× faster or more (unmeasured) | Memory first |

Arithmetic:
- 300 attaches × 83 ms = 24.9 s. With 4 workers, 6.2 s.
- Agent output: assume 20 KB/s per session while it streams. 30 × 20 KB/s = 0.6 MB/s, 13% of 4.7 MB/s.
  300 × 20 KB/s = 6 MB/s, which is past one core and needs C or D. The 20 KB/s is an
  assumption: measure it (Unknown, below).
- Memory: 1.1 GB / 30 is about 37 MB per session at 6000 lines × 160 columns.
  300 sessions is 11 GB; 3000 sessions is 110 GB. Memory, not CPU, bounds 100×.
- Worker messages: 48 MB/s measured for 16 KB batches, 10× the parse rate. The copy is not the limit.

## Choice

**B, built with C's routing.** It removes the thread's stalls at today's size, and it is the
smallest change that does. The messages are the same in C, so a second worker is a number.

- A lost because a serialize still holds every session, and the next requirement (more sessions,
  guests attaching) multiplies serializes.
- C now lost because 30 sessions need 13% of one core. Four isolates would cost memory for
  throughput nobody uses yet.
- D lost for now: it rewrites the serializer every client depends on. It is the upgrade when
  parse throughput bites, and the worker boundary from B is where it plugs in.

**What was surprising.**
- Parse runs at 4.7 MB/s, not hundreds. The ceiling at 10× is parse CPU, not message copies.
- Most of the stall was serialize, which scales with scrollback. Sending 1000 lines instead of 5000
  did more than a thread would at today's size. The thread is for isolation, not raw speed.
- Memory, about 37 MB per session, bounds 100× before CPU does. A smaller saved scrollback per idle
  session (or the sleep feature, which ends idle sessions) is the lever there.

## Pre-mortem

It is a year later and B failed. The likely reasons, and what changes:

1. **The worker fell behind and the screens were wrong.** Bytes reach clients before the worker
   parses them, so a screen asked for at "now" could miss the last batch. Fix: each serialize
   carries `at` (the byte count the screen covers), as `serializeDrained` does today, and main
   appends the ring's tail after `at`. When the ring no longer holds it, the screen waits for the
   worker to reach `at`. A screen is never older than the bytes after it.
2. **A flood ate memory.** With no bound, a `cat` of 2 GB queues 2 GB for the worker. Fix: a bound
   per session (1 MB queued). Past it, main pauses that PTY with the pause path `pause`/`resume`
   already use for viewers. The program waits, as under tmux. Only the noisy session waits.
3. **The worker crashed, and every screen went with it.** Fix: main restarts the worker and each
   session's xterm is rebuilt from its last saved snapshot plus the ring. A session whose ring no
   longer covers the gap is marked so that its next screen is the saved one, and it says so in the
   log. Ceiling: a crash loses scrollback newer than the last save and older than the ring.

**Known ceiling.** One worker parses about 4.7 MB/s in total. When measured output passes half of
that, add workers (C). When one session alone passes it, D.

## Build order

1. **Name the screen interface.** `SessionScreen` holds `write`, `resize`, `serialize(lines, at)`,
   `viewport`, `modes` and `title`, implemented in-thread by today's xterm. The manager calls only
   that. Check: the daemon and manager tests pass unchanged; no other file touches `s.term`.
2. **Modes as data.** Bracketed paste, mouse encoding and title arrive as events and are kept on
   the session. `write` and `withTitle` read the copy. Check: the paste and replay-mode tests pass;
   a test pastes right after `\x1b[?2004h` and gets the brackets.
3. **The worker.** The same interface over `postMessage`, one worker, sessions routed by id. Check:
   the full daemon suite passes with the worker on; a new test floods one session with 50 MB while
   another echoes keys, and the echo stays under 50 ms (it is seconds today).
4. **Bound and back-pressure.** A queue per session; pause past 1 MB, resume below 256 KB. Check:
   flooding a session keeps the daemon's RSS flat, and the flooding program sees its writes block.
5. **Crash recovery.** Restart the worker and rebuild from snapshot plus ring. Check: kill the worker
   mid-flood; every session's next screen arrives, and the log names any gap.
6. **Measure.** `show30` and the echo-latency probe on a quiet machine, with numbers in the
   changelog line.

About 1–2 days of agent time for steps 1–5. Step 1 is safe to land alone.

## Unknown

- **Real output rates per agent session.** 20 KB/s is an assumption. Check: log bytes per session
  per minute from the daemon for a day of normal use.
- **Parse rate on a quiet machine.** 4.7 MB/s was measured at load 26. Check: rerun
  `worker-cost.ts` at load under 2.
- **alacritty's parse rate under wasm and napi** for option D. Check: a bench over the same bytes
  in `crates/hive-phone`.
- **Whether `@xterm/headless` runs in a worker under the Electron-as-node daemon** the app starts.
  Check: step 3's first test, under the packaged app.
