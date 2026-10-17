# Sleep and wake agents (2026-10-17)

Status: accepted for building; the daemon steps are built (ffd9de9, 9407ee0).

**Verdict.** Sleep is a *discard*, not a *freeze*: the agent's process ends, and what it needs to
come back (its screen, its spawn spec, the conversation id its manifest resumes) stays where the
daemon already keeps a session saved before a reboot. A flag on the tile in the workspace layout
says it sleeps, so every window, the phone and guests see it. Waking is the restore path that
already runs after every reboot (its spec turned into the agent's `--resume`), opened only by an
attach that says `wake`, so no other viewer can start it.

## Problem

The person keeps agents only for reference: project A has 5 agents, B has 4; they want A's 5 to
stop costing anything while their titles stay, and wake any one later with its conversation.

**Goal.** Sleeping a tile, a frame or a workspace frees each agent's process (CPU and memory); the
tile keeps its title and its last screen, dimmed, with Resume; Resume continues the same
conversation.

**Constraints.**
- The person chose: a dimmed last screen (not a small card); the flag lives in the workspace
  layout so every view sees it.
- Every surface: `hive ctl sleep|wake <tile|frame|workspace> [--json]`, the canvas tile, the
  Layers panel, the frame and workspace menus, the phone's list, `hive host`.
- Nothing per event: no work on output, status or store changes for tiles that sleep.
- No compatibility shims; protocol changes say **Breaking:** only if a shape changes (they only
  add fields).

**Real numbers** (this machine, load 55-62 on 16 CPUs, 2026-10-17):

| What | Number | Source |
|---|---|---|
| `claude` processes running | 41, 14.3 GB RSS in all | `ps -C claude -o rss=` |
| One `claude` | 217-573 MB, mean ~358 MB, + 46-78 MB per MCP child | same |
| Idle `claude` CPU | 0.5-6 % each (30 of 41 idle) | `ps -o %cpu` |
| Session snapshot on disk | median 12 KB, p90 15 KB, max 537 KB (83 files) | `~/.config/hivemind/sessions` |
| Claude transcript | median 427 KB, p90 2.7 MB, max 417 MB | `~/.claude/projects/**/*.jsonl` |

Sleeping one idle agent frees ~360 MB and a few % of a CPU. A frame of 5 frees ~1.8 GB.

Measured with the daemon step (`bench-sleep.ts`, 5 real Claude Code agents in their own daemon,
load ~100 on 16 CPUs): awake, their process trees held **2746 MB**; asleep, **0 processes, 0 MB**;
the daemon itself went 116 → 98 MB. Sleeping the 5 took 6.1 s.

**Known problem.** Session parking: a browser discarding a tab, a terminal reviving a persistent
session, tmux-resurrect restoring programs. The live process is dropped, a description of it is
kept, and it is started again from that description.

## What others do

- **Chrome Memory Saver / Page Lifecycle** (developer.chrome.com/docs/web-platform/page-lifecycle-api):
  two states, *frozen* (no CPU, memory kept) and *discarded* (unloaded, reload on select). Only
  discarding frees memory; no event fires before it, so state must already be saved. → Sleep is
  "discarded"; save before nothing, but *after* the process ends (see the daemon step).
- **VS Code persistent terminals** (github.com/microsoft/vscode `platform/terminal/node/ptyService.ts`):
  serializes the buffer and launch config, revives a *new* process with the old buffer written
  first and a "History restored" line after it. It revives the shell, not the program in it. → We
  revive the agent itself through its manifest's resume, and mark where the old screen ends.
- **tmux-resurrect / continuum** (github.com/tmux-plugins/tmux-resurrect `docs/restoring_programs.md`):
  saves layout, cwd, pane contents; restores programs by a per-program rule (`~rails->rails *`).
  Bugs: cwd reset to `$HOME`, piling-up prompts. → Our per-program rule already exists: the agent
  manifest's `session.resume`, applied by `transformSpecOnRestore`.
- **cmux session restore** (cmux.com/docs/session-restore): captures each agent's own session id
  through hooks and runs `claude --resume <id>`, `codex resume <id>`; drops secrets from the saved
  env. → Same shape as ours (tracked id in `tile-sessions/`, token redacted in the snapshot).
- **Firefox tab unloading** (firefox-source-docs.mozilla.org/browser/tabunloader/): skips tabs
  playing media or in a call. → Do not sleep an agent that is mid-turn or waiting on an approval
  unless told to.
- **Kernel freezer / SIGSTOP** (docs.kernel.org cgroup-v2 `cgroup.freeze`): stops CPU, keeps every
  page. **CRIU** (criu.org/Inheriting_FDs_on_restore): needs `--shell-job`, a real tty on restore,
  and cannot keep the agent's TLS connections. → Neither frees memory cheaply and safely.
- **Claude Code issues**: resuming a session that is still running forks its transcript
  (anthropics/claude-code#97833); transcripts are deleted after `cleanupPeriodDays` (30). →
  Never let two processes own one session; a sleep older than 30 days may not resume.

## The design, from every side

| View | Worry | Answer |
|---|---|---|
| User | Resume silently starts a blank agent | Sleep refuses an agent whose manifest cannot resume; a wake whose resume fell back says so (`resumed: false`, and the restore retry's banner) |
| User | Sleeping kills a turn in flight | `sleep` skips a tile that is working or waiting on someone, unless `--force`, and lists it |
| User | The tile loses its name | The status keeps its last title while it sleeps; the saved screen carries it too |
| Data | Who says it sleeps | Two facts, one direction (below): the daemon's sleep mark decides whether a process may start; the layout flag decides what views draw. Only the control plane writes either, in a fixed order |
| Data | A window saving a stale layout drops the flag | The store rebases a window's write on its base (`rebaseFields`), so a tile it did not touch keeps the flag (store test). If the flag is lost anyway, nothing wakes: the window's attach is answered "asleep" and it draws the sleeping tile |
| 3 am | Sleep never finishes | SIGHUP to the process group; SIGKILL to the group after 15 s. Measured: Claude Code ends on SIGHUP in ~4.5 s at load 100 (its exit hooks); SIGTERM and SIGINT did not end it in 6 s |
| 3 am | Sleep fails half-way (device gone, save failed) | The flag is cleared again and the answer names the tile and why |
| 3 am | Daemon restarts while tiles sleep | The mark is in the snapshot: they are asleep again at boot, and exempt from the 30-day retention |
| Security | A guest wakes the host's agents | `agent.sleep`/`agent.wake` need `agents`; a guest's attach never carries `wake`; `sleeping` is a field a board-edit guest may not change (`edit-rules.ts`, like `cmd`) |
| Cost | Disk, daemon | One snapshot per sleeping tile (median 12 KB, +the 1000-line screen); the daemon keeps each sleeper's `SessionInfo` once read, so `hive ps` and `hive host`'s start do not re-read every file |
| Next year | Auto-sleep after N idle hours; sleep on low memory; sleep shells | Each is a caller of the same `sleep`; shells need a "start again in place" resume rule first |

### Two facts, one direction

Whether a tile sleeps lives in two places on purpose, because two different readers need it and
neither can reach the other's: every view (phone, guests) reads the **layout flag**, synced with
the document; only the machine running the agent can stop a process from starting, so the
**daemon's sleep mark** (in the session's snapshot) decides that. They cannot drift into harm:

- Only the control plane writes them. Sleep: flag on → daemon `sleep` → on failure, flag off.
  Wake: daemon attach with `wake: true` (mark cleared as the session starts) → flag off.
- No other attach restores a marked session (a window, a reconnect, a guest, "press Enter to
  restart"): it is answered `asleep`. A flag lost by mistake shows the sleeping tile, never a
  second process; a flag left on by mistake shows a saved screen with Resume, which wakes it.

## Options

**A. Kill and remember in the layout (boring).** The window kills the session with today's
`kill`, stores the last screen and the resume id in the tile record, and starts a new session with
`--resume <id>` on Resume.

```
window ──kill──▶ daemon (snapshot + tracked id DELETED)
window ──setCore(tile.screen=…)──▶ store ──sync──▶ every peer (MBs)
```
Breaks first: the screen rides the layout document to every peer and every undo step (a 537 KB
screen × 50 tiles = 27 MB in a CRDT); `kill` evicts the tracked id the resume needs; the resume
rule is re-implemented in the window instead of the manifest.

**B. Daemon sleep + layout flag + control-plane owner (chosen).**

```
hive ctl / menu / phone ──agent.sleep(target)──▶ control plane (host)
   1. store: tile.sleeping = true              ──sync──▶ windows, phone, guests
   2. backend.sleep(pty) ──▶ daemon: screen taken → SIGHUP(group) → exit{slept} → saved, marked
   3. control.slept(tile): status "sleeping", waiters told, links kept
window: tile.sleeping ? <SleepingTile> (terminal.saved → dimmed static screen + Resume)
                      : <TerminalTile> (attach; "asleep" → draws SleepingTile)
wake: terminals.own(tile, wake) ──▶ daemon restore → --resume <id>; then store: sleeping off
```
Breaks first: the agent's own transcript is pruned by the agent (Claude: 30 days), after which a
wake resumes nothing (written ceiling below).

**C. Freeze in place (bold, rejected).** SIGSTOP the process group (or cgroup freeze), keep the
xterm live; or CRIU-checkpoint it to disk.

```
daemon ──SIGSTOP──▶ agent (RSS kept)          criu dump ──▶ images (tty + TLS sockets break)
```
Breaks at once: SIGSTOP frees no memory (the requirement); CRIU needs a real tty on restore and
cannot restore the agent's network connections to its model API.

**D. Desired-state reconciler.** Any writer sets the flag; the host watches every layout change
and sleeps/wakes sessions to match.

Breaks first: work on every store change (CLAUDE.md "work that runs per event"), and a guest who
may edit the board but not run agents could wake processes by writing a field. Kept as the
upgrade path for "auto-sleep" (one writer, the policy, still goes through `sleep`).

### Scale

Per sleeping tile, B keeps: one snapshot file, one entry in the daemon's frozen map (its loader and,
once read, its `SessionInfo`), ~16 bytes of layout. It frees one agent process tree.

| Design | Today (5 sleeping) | 10x (50) | 100x (500) |
|---|---|---|---|
| A | layout +60 KB median, +2.7 MB worst; holds | +600 KB / +27 MB in every peer's doc and undo history: **breaks** | +6 MB / +270 MB: breaks |
| B | disk ~0.1 MB; 1.8-2.7 GB freed; holds | disk 1-27 MB; first `hive ps` after a daemon start reads 50 files, later ones none; a window opening 50 sleepers gets 50 × ≤1000-line screens once; holds | disk 10-270 MB; first `hive ps` reads 500 files (≈ 500 × 25 KB parse, ~100 ms on the daemon thread, once per daemon start); holds |
| C | 0 freed: fails the goal | 0 freed | 0 freed |
| D | as B + one layout scan per store change (5 tiles: ~µs) | 50-tile scan per change: holds but is per-event work | 500-tile scan per change on main: avoid |

Arithmetic: snapshot median 12 KB, max 537 KB (measured); the sleep save adds the 1000-line screen
(≤ the full one), so ~25 KB median; 5 × 25 KB ≈ 0.1 MB, 50 × 537 KB = 27 MB. Freed memory:
measured 2113-2746 MB for 5 (bench), 5 × 358 MB = 1.8 GB from the `ps` survey. `info()` reads
each frozen snapshot it has not read before.

## Choice

B. A loses on data placement (screens in a synced CRDT) and re-implements resume in the window;
C does not free memory; D puts work on every store change and widens who can start processes.

What was surprising: (1) the daemon already restores frozen sessions with `--resume`, so the hard
part is *who may start a process*: a plain attach restores, and many paths attach (a guest, a
reconnect, Enter-to-restart). The sleep mark plus an explicit `wake` closes all of them at once.
(2) Claude Code clears its screen as it ends, and ends on SIGHUP only after ~4.5 s: the screen
must be taken before the signal, and the grace must be long.

### The pieces

1. **Daemon.** Built: ffd9de9, 9407ee0. To build (third agent-host commit):
   - The snapshot of a sleeping session carries `sleeping: true`. An attach restores it only with
     `wake: true`; any other is answered `attached {pid: -1, asleep: true}`. The mark goes when
     the woken session saves again.
   - Signals go to the process group (`-pid`): SIGHUP, then SIGKILL after `SLEEP_GRACE_MS` = 15 s;
     when the leader has ended, SIGKILL to what is left of its group (an MCP server ignoring
     SIGHUP is not left behind). Windows: the pty's own kill.
   - Retention skips sleeping snapshots (only the files past 30 days are read to tell).
   - `info()` keeps each frozen session's `SessionInfo` once read; a sleep records it with no read.
   Kept from before: the screen is taken before the signal (whole, and the newest 1000 lines);
   `exit{slept}`; `slept` answered once on disk; `screen {saved, lines}` read with `fs.promises`,
   the 1000-line screen when `lines` ≤ 1000.
2. **Endpoint and backends.** `DaemonEndpoint.sleep(id)`, `saved(id, lines)`; `spawn({wake})`;
   `onExit(code, signal, slept)`; an `asleep` attach answer. `SessionBackend.sleep(tile)`,
   `saved(tile, cwd, lines)`, `kill(tile, cwd?)`: a session that is not running is routed by its
   tile's folder, not by "is it attached here" (a sleeping ssh or device tile is not). Backends:
   the local daemon (app and `hive host`), an ssh machine's daemon, another of the person's
   devices (hive-net). Refused, with the reason in the answer: a tile on a participant's machine
   (theirs to run), an ssh machine without a daemon (an in-app `ssh -tt` cannot keep a session).
3. **Layout.** `TileRecord.sleeping?: true`; `WorkspaceStore.setSleeping(tileId, on, from)`, one
   field, like `renameTile`. `sleeping` joins the fields a board-edit guest may not change. A frame
   or workspace has no flag: it sleeps when its agent tiles do.
4. **Control plane.** `sleepTiles(target, {force})` / `wakeTiles(target)` in
   `packages/host/src/control/methods.ts`, shared by the app and `hive host`. A target resolves to
   a tile (id or name), else a frame (id or title), else a workspace (path or id). Sleep: agent
   tiles whose manifest has `session.resume`, not busy unless forced; flag, then `backend.sleep`,
   flag off again on failure. `control.slept(tile)` instead of `exited`: status `sleeping` with its
   title kept, a `hive ctl read` waiting is answered "asleep", the spawn record, supervision and
   pipes are kept; `hive ctl send` to a sleeping tile is refused ("asleep: wake it first").
   Wake: `terminals.own` with `wake`, then flag off; `resumed` from whether the restore kept the
   resume. Workspace API: `agent.sleep(target, force?)`, `agent.wake(target)` (permission
   `agents`); `terminal.saved(tile, cwd, lines?)` (permission `view`).
   `hive ctl sleep|wake <target> [--force] [--json]` →
   `{ slept|woke: string[], skipped: { tile, why }[] }`.
5. **Window.** A sleeping tile (flag, or an attach answered `asleep`) draws `SleepingTile`: its
   title, its saved screen (`terminal.saved`, 1000 lines) turned once into static dimmed HTML (no
   live xterm, no WebGL context), cached per tile until it wakes, "Asleep", Resume.
   `TerminalTile` takes `exit{slept}` quietly: no "press Enter to restart", no "exited" status.
   Tile menu, Layers row, frame menu, workspace menu: Sleep / Wake.
6. **Phone.** `agentsOf` lists a sleeping tile with `state: "sleeping"` (from the flag, even with
   no status); the row shows it and offers Wake (`agent.wake`).

## Review round 1 (a fresh reviewer, 9 material points)

| # | Point | Answer |
|---|---|---|
| 1 | Any attach without `liveOnly` restores a frozen session: guests rewritten to `attachOnly`, reconnects, ssh, Enter-to-restart all wake a sleeper, past the `agents` gate | Sleep mark + `wake: true` (piece 1) |
| 2 | An attach racing the sleep re-calls `createOrAttach` and restores at once | Same: after the sleep it is marked, so the second call is answered `asleep` |
| 3 | The machine-share relay drops `sleep`/`saved`; a sleeping ssh/device tile's `kill` and `saved` go to the local daemon | Route by the tile's folder (piece 2); participant machines refused |
| 4 | Sleep runs `control.exited`: spawn record, supervision, mailbox, pipes forgotten; readers told "exited"; a tile no window shows never hears the exit | `control.slept`, called by the control plane after `backend.sleep` resolves, not from a viewer's exit (piece 4) |
| 5 | A board-edit guest could clear or set `sleeping` | Protected field (piece 3) |
| 6 | Flag first with no rollback | Flag off again on failure (piece 4) |
| 7 | SIGHUP/SIGKILL hit only the leader: MCP children orphaned | Group signals and a group SIGKILL after the leader ends (piece 1); the bench checks no descendant survives |
| 8 | Retention prunes a sleeper at 30 days and evicts its tracked id; wake then starts blank silently | Sleepers exempt from retention; `resumed: false` from the restore (piece 4) |
| 9 | `hive host`'s start and `hive ps` read every frozen snapshot | `SessionInfo` kept per frozen session (piece 1) |
| minor | Title lost; screen refetched on remount; `send` during the grace; ssh without daemon; idle daemon exit | Title kept in status; cached HTML; `send` refused; refused with reason; an idle daemon with only sleepers still exits (they are on disk) and starts again when asked: accepted |

## Pre-mortem (a year on, it failed)

1. **"Resume brought back a blank agent."** The transcript was pruned by the agent, or the agent
   has no resume rule. Changed: sleep refuses an agent with no `session.resume`; sleepers are
   exempt from our retention; the restore's `vanished` check (runtime-manifest.ts) and retry
   banner, and `wake --json` reports `resumed: false`. Ceiling: Claude deletes transcripts after
   `cleanupPeriodDays` (30 by default); past it the conversation is gone wherever we keep the
   screen. Upgrade: show the sleep's age on the tile, and warn past 25 days.
2. **"Two agents wrote one conversation."** Changed: only a `wake` attach restores; the session
   stays exited-and-sleeping in the manager until it is saved and marked; an attach meanwhile
   waits and is then answered `asleep`.
3. **"Sleeping a workspace killed a running task."** Changed: busy tiles are skipped unless
   `--force`, and listed in the answer.

Other ceilings: waking 50 tiles at once spawns 50 agents — paced by the existing spawn pacer, each
taking its resume time. A sleep takes the agent's own exit time (Claude: ~4.5 s at load 100) up to
15 s; the flag is set first, so the tile dims at once.

## Build order

1. Daemon `sleep` / `slept` / `screen{saved}`. **Done: ffd9de9, 9407ee0** (`tests/sleep.test.ts`,
   7 mutants).
2. Daemon: sleep mark + `wake`, group signals, retention exemption, `SessionInfo` kept — the same
   test file: a plain and a `noSpawn` attach are answered `asleep`, a `wake` attach restores; a
   child ignoring SIGHUP does not survive; a marked snapshot past retention stays.
3. `TileRecord.sleeping` + `WorkspaceStore.setSleeping` + the guest edit rule — store test (done,
   2 mutants) and an edit-rules row.
4. Endpoint and backends (local daemon, `hive host`, ssh daemon, devices) — a host test driving
   `Terminals` over a real daemon: sleep ends the process, the exit says slept, `terminal.saved`
   gives the screen, an attach is answered asleep.
5. Control plane `sleepTiles/wakeTiles`, `control.slept`, `agent.sleep/agent.wake`, `hive ctl
   sleep|wake` — ctl tests over the drive socket (tile/frame/workspace targets, busy skip,
   rollback, `--json` shape).
6. Window: `SleepingTile`, quiet slept exit, menus, Layers — unit test of the screen-to-HTML step;
   e2e specs listed for the coordinator.
7. Phone: `state: "sleeping"` in `agentsOf`; Wake on the rows (Android, iOS).
8. Bench (`bench-sleep.ts`): 5 real agents, RSS of their trees before / after, no descendant left,
   Resume continues the conversation (the agent recalls a word given before sleep).

## Unknown

- Wake latency for a large transcript. Check: the bench times wake → prompt.
- Whether an MCP server that starts its own session (`setsid`) escapes the group kill. Check: the
  bench lists every descendant of each agent before sleep and checks each pid after.
- iOS cannot be built on this Linux machine. Check: the Swift change is kept to the row's label
  and one action, and listed for the coordinator to build.
