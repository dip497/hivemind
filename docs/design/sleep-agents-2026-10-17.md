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
| User | Resume silently starts a blank agent | Sleep refuses an agent whose manifest cannot resume; a wake whose resume fell back says so on the tile (the restore retry's banner) |
| User | Sleeping kills a turn in flight | `sleep` skips a tile that is working or waiting on someone, unless `--force`, and lists it |
| User | The tile loses its name | A sleep is not an exit: the title is not cleared and the status is not set `exited`; the saved screen carries the title too |
| Data | Who says it sleeps | Two facts, one direction (below): the daemon's sleep mark decides whether a process may start; the layout flag decides what views draw. Only the control plane writes either, in a fixed order |
| Data | A window saving a stale layout drops the flag | The store rebases a window's write on its base (`rebaseFields`), so a tile it did not touch keeps the flag (store test). If the flag is lost anyway, nothing wakes: the window's attach is answered "asleep" and it draws the sleeping tile |
| 3 am | Sleep never finishes | SIGHUP to the process group; SIGKILL to the group after 15 s. Measured: Claude Code ends on SIGHUP in ~4.5 s at load 100 (its exit hooks); SIGTERM and SIGINT did not end it in 6 s |
| 3 am | Sleep fails half-way (device gone, save failed) | The flag is set only once the daemon has saved the sleeper, so there is nothing to undo; a process that ended unsaved is an exit like any other, and the answer names the tile and why |
| 3 am | Daemon restarts while tiles sleep | The mark is in the snapshot: they are asleep again at boot, and exempt from the 30-day retention |
| Security | A guest wakes the host's agents | `agent.sleep`/`agent.wake` need `agents` and are scoped to the caller's workspace; a guest's attach never carries `wake` (it is not in `TerminalOpts`); `terminal.saved` is scoped by tile and its folder found on the host; `sleeping` is a field a board-edit guest may not change (`edit-rules.ts`, like `cmd`) |
| Cost | Disk, daemon | One snapshot per sleeping tile (median 12 KB, +the 1000-line screen); the daemon keeps each sleeper's `SessionInfo` once read, so `hive ps` and `hive host`'s start do not re-read every file |
| Next year | Auto-sleep after N idle hours; sleep on low memory; sleep shells | Each is a caller of the same `sleep`; shells need a "start again in place" resume rule first |

### Two facts, one direction

Whether a tile sleeps lives in two places on purpose, because two different readers need it and
neither can reach the other's: every view (phone, guests) reads the **layout flag**, synced with
the document; only the machine running the agent can stop a process from starting, so the
**daemon's sleep mark** (in the session's snapshot) decides that. They cannot drift into harm:

- Only the control plane writes them, one sleep or wake per tile at a time. Sleep: daemon
  `sleep` (screen saved, mark on) → flag on. Wake: daemon attach with `wake: true` (mark
  cleared as the session starts) → flag off. A wake acts on the daemon's mark, flag or not.
- No other attach restores a marked session (a window, a reconnect, a guest, "press Enter to
  restart"): it is answered `asleep`. A flag lost by mistake shows the sleeping tile, never a
  second process; a flag left on by mistake shows a saved screen with Resume, which wakes it, or,
  when nothing sleeps there any more (retention, `hive kill`, a machine that lost its state), is
  told `gone` and clears the flag: shown again, the tile starts afresh.

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
   3. the slept exit: status kept (a turn in flight interrupted), waiters told, links kept
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
   - Retention keeps sleeping snapshots 90 days, not 30 (only the files past 30 days are read to
     tell): by then an agent has usually let go of the conversation itself.
   - `info()` keeps each frozen session's `SessionInfo` once read; a sleep records it with no read.
   Kept from before: the screen is taken before the signal (whole, and the newest 1000 lines);
   `exit{slept}`; `slept` answered once on disk; `screen {saved, lines}` read with `fs.promises`,
   the 1000-line screen when `lines` ≤ 1000.
2. **Endpoint and backends.** `DaemonEndpoint.sleep(id)`, `saved(id, lines)`; `spawn({wake})`;
   `onExit(code, signal, slept)`; an `asleep` attach answer. `SessionBackend.sleep(tile)`,
   `saved(tile, cwd, lines)`, `kill(tile, cwd?)`: a session that is not running is routed by the
   folder it slept in (the flag's value), not by "is it attached here" (a sleeping ssh or device
   tile is not). An `asleep` answer to a reconnect's re-attach is an `exit{slept}`. Backends:
   the local daemon (app and `hive host`), an ssh machine's daemon, another of the person's
   devices (hive-net). Refused, with the reason in the answer: a tile on a participant's machine
   (theirs to run), an ssh machine without a daemon (an in-app `ssh -tt` cannot keep a session).
3. **Layout.** `TileRecord.sleeping?: string`, the folder it slept in (a tile moved to a frame on
   another machine still wakes, shows and ends where its session is), written by the owner only;
   `WorkspaceStore.setSleeping(tileId, folder | null, from)`, one field, like `renameTile`.
   `sleeping` joins the fields a board-edit guest may not change. A frame or workspace has no
   flag: it sleeps when its agent tiles do.
4. **Control plane.** `sleepTiles(target, {force})` / `wakeTiles(target)` in
   `packages/host/src/control/methods.ts`, shared by the app and `hive host`. A target resolves to
   a tile (id or name), else a frame (id or title), else a workspace (path or id), within one
   workspace; a name that matches more than one is refused. Sleep: agent tiles whose manifest
   has `session.resume`, not busy unless forced; `backend.sleep`, then the flag. Every exit
   carries `slept`, and a slept exit never runs `control.exited` (spawn record, supervision,
   mailbox, inbox and pipes kept); the title is not cleared; a `hive ctl read` waiting is
   answered "asleep"; `hive ctl send` to a sleeping tile is refused ("asleep: wake it first").
   Wake: `terminals.own` with `wake`, then flag off, then the mailbox and inbox are told it woke.
   The mailbox holds what comes for a sleeper (nothing is typed into it), and, woken, holds it
   until the agent says its session started (`session.started`), or, for one that reports no
   turns, for a moment (2 s); then it is typed, a worker's report sent while its parent slept
   included. The control plane runs `control.slept` itself once the sleep resolves, so a sleeper
   no window shows is not left "working". A wake answered `gone` clears the flag and says why.
   Per-tile queue: a wake waits for a sleep in flight. Another tile may not start a sleeper's
   conversation: every start passes `Terminals`, which asks the control plane whether its
   arguments name a conversation a sleeping tile holds (the window's own "Resume conversation"
   included); a wake is refused while another tile runs that conversation. Workspace API: `agent.sleep(workspace, target, force?)`,
   `agent.wake(workspace, target)` (permission `agents`, scoped like `agent.start`);
   `terminal.saved(tile, lines?)` (permission `view`, scoped by tile; the host reads the folder).
   `hive ctl sleep|wake <target> [--force] [--json]` →
   `{ slept|woke: string[], skipped: { tile, why }[] }`.
5. **Window.** A sleeping tile (flag, or an attach or exit that says so) draws `SleepingTile`: its
   title, its saved screen (`terminal.saved`, 1000 lines) turned once into static dimmed HTML (no
   live xterm, no WebGL context), cached per tile until it wakes, "Asleep", Resume.
   `TerminalTile` takes `exit{slept}` quietly: no "press Enter to restart", no "exited" status.
   The flag goes on only after the screen is saved, so `SleepingTile` never fetches an empty one.
   Tile menu, Layers row, frame menu, workspace menu: Sleep / Wake.
6. **Phone.** No new status state (the phone core drops agents in a state it does not know):
   `agentsOf` lists a sleeping tile with `sleeping: true` beside its state (from the flag, even
   with no status). The phone core reads it (`only_true`, like its other flags); the row shows
   "Asleep" and offers Wake (`agent.wake`). Three phone surfaces read it: Android, iOS and the
   browser phone (`crates/hive-web`), each with its Home row, its agent screen (the saved screen
   for a sleeper) and Wake.

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

## Review round 2 (a fresh reviewer, 9 material points)

| # | Point | Answer |
|---|---|---|
| 1 | `control.exited` still runs from every exit callback before `control.slept`; the daemon clears the title and a standalone daemon sets `exited` | `slept` carried through every `onExit`; a slept exit skips `control.exited`, the title clear and the standalone daemon's `exited` (piece 4) |
| 2 | Flag first: `SleepingTile` fetches `saved` while the session still runs, gets null, caches it | Flag set after the daemon saved it (Two facts) |
| 3 | The folder is not known where kill runs; a sleeping tile moved to another machine's frame | The flag holds the folder it slept in; close reads it before removing the tile (piece 3) |
| 4 | `agent.sleep/wake(target)` cross workspaces; `terminal.saved(tile, cwd)` lets a viewer pick the machine | Workspace-scoped `agent.sleep/wake(workspace, …)`; `terminal.saved(tile, lines?)` scoped by tile, folder from the host (piece 4) |
| 5 | Resume during a sleep: the endpoint gives up at 6 s, the late attach runs unseen | One sleep or wake per tile at a time; a wake waits (piece 4) |
| 6 | Rollback cannot make it awake: the process is dead | No rollback needed: flag after success; unsaved = an exit (3 am row) |
| 7 | Mark on, flag off (link dropped mid-sleep, crash after wake); `asleep` on a re-attach fires nothing | Wake acts on the mark, flag or not; `asleep` on a re-attach is `exit{slept}` (pieces 2, 4) |
| 8 | A new `sleeping` state is dropped by the phone core and breaks the FFI enum, spec and schema | `sleeping: true` beside the state (piece 6) |
| 9 | A parent's inbox doorbell rings into no session; nothing rings again on wake | Ring the inbox on wake (piece 4) |
| minor | Quick-fail retry after `resumed: true`; quit mid-wake leaves flag on and `saved` null; wake at fixed size; plugin uninstalled while asleep; ambiguous name; group SIGKILL gives children no extra grace; Windows hard kill | `resumed` is best effort, the retry banner is the truth; `SleepingTile` with no saved screen attaches `liveOnly` and, live, asks the control plane to clear the flag; size accepted (resized at once); wake refused with "no agent X installed"; ambiguous name refused; children got the SIGHUP with the leader, so the leader's exit time is their grace; Windows accepted |

## Review round 3 (a fresh reviewer, 5 material points)

| # | Point | Answer |
|---|---|---|
| 1 | The daemon's snapshot write swallows errors, so a failed save is answered `slept`; a lost mark or snapshot lets an attach start the agent afresh; `wake` on an id with nothing asleep spawns fresh; viewers are told `slept` before the save | Built: the write rejects to the manager; viewers get `exit{slept}` only once it is on disk (else a plain exit); the in-memory mark survives an unreadable snapshot and such a sleeper is never started; `wake` with nothing asleep is refused ("nothing asleep as X", listed in `skipped`); a wake during the grace waits and restores. Tests in `sleep.test.ts` |
| 2 | An `agents` guest may write any tile field (`edit-rules.ts`: `drives` returns early), so a forged `sleeping` folder would route a wake or read to another machine | `sleeping` is owner-only, checked before the `drives` return; an edit-rules row for an `agents` guest |
| 3 | `sleep(tile)` routes by "attached here", so a detached device or ssh tile goes to the local daemon | `sleep(tile, cwd)` routes by folder like `saved` and `kill`; the host test sleeps a detached session |
| 4 | The wake attach's 6 s timer counts ssh connect and load: a slow wake runs unseen with the flag on | The wake attach waits 30 s, like a sleep; on no answer the tile stays asleep and is listed "no answer"; pressing Resume again attaches with `wake` and joins it, since a wake on a live session is a plain attach |
| 5 | Resuming a sleeper's conversation in a new tile, then waking the sleeper, puts two processes on one conversation | `agent.start({resume})` refuses an id that a sleeping tile on this machine holds ("asleep in tile X: wake it"); ceiling: a sleeper on another machine is not checked |
| minor | Doc said status "sleeping"; client-chosen folders; `saved` with no timeout; >128 wakes overflow the pacer; orphan snapshots of tiles removed by sync; wake in the grace | Status is kept (piece 4); folders from the host (built); `saved` gives up after 10 s (null); a refused start is listed in `skipped`; orphan sweep is a ceiling (disk only, ~12 KB each); the grace wake is built |

## Review round 4 (a fresh reviewer, 5 material points)

| # | Point | Answer |
|---|---|---|
| 1 | Windows: the pty's `kill(signal)` throws, both signals are swallowed, the sleep never ends and every attach waits on it | Built: a pty that refuses a signal is ended outright (`sleep-no-signals.test.ts`) |
| 2 | The 30 s timers stop the host waiting, not the daemon: a wake goes on unseen, a sleep finishes with no flag and a blank tile | A sleep or wake that times out is asked again once: both are idempotent at the daemon (a sleep in flight answers when done; a wake on a live session attaches). Each tile's flag is set as its own sleep resolves. `terminal.saved` uses the tile's folder: where it slept, else its frame's (built). `SleepingTile` fetches again when the flag lands and never caches a null |
| 3 | An ssh wake with no daemon falls back to plain ssh: a fresh agent, the conversation left on the remote | Built: a wake there is refused ("what slept there cannot be woken") |
| 4 | The phone builds its list from Home rows, which carry no `sleeping`, and drops a tile with no state; its agent screen attaches live only | Step 7 widened: `sleeping` in `HomeTile`, `homeRows`, the phone's `TileRow`, `LayerTile` and `status_of`; a sleeper with no status is `idle`; the phone's agent screen shows `terminal.saved` for a sleeper |
| 5 | A sleeping ssh or device tile closed through sync, or by the control plane after it removed the tile, is killed on the wrong daemon and kept forever | The control plane reads the flag's folder before removing the tile and passes it to the end; a window's close finds it while the tile is still in the host's layout; one closed through sync is left to retention, now 90 days for a sleeper (built), not forever |
| minor | `resumed` has no channel; a paused session sleeps at SIGKILL; an unreadable sleeper after a restart is not known asleep; adopted tiles; bare ids; `folderOf` not wired; HTML from agent output; pipes into a sleeper; the store still writes `true` | `resumed` dropped (the banner says it); paused: built (host test, under node); unreadable after a restart: ceiling, as for any corrupt snapshot; adopted tiles skipped like close skips them; ids normalised (built); wiring and the store's folder in step 5; the screen is built from escaped text nodes, styles only from the palette; a pipe into a sleeper is dropped: ceiling, listed in the answer |

## Review round 5 (a fresh reviewer, 4 material points)

| # | Point | Answer |
|---|---|---|
| 1 | The status is fixed only by the slept exit, which reaches the host only while something there is attached: a sleeper no window shows stays "working" or "waiting" everywhere, and later sleeps skip it as busy | Built: `sleepTiles` runs `control.slept` once the sleep resolves (the exit's call stays; twice is once). `control-sleep.test.ts` |
| 2 | A flag whose sleeper is gone (retention, `hive kill`, lost machine state) can never be cleared: every wake is refused "nothing asleep" | Built: the daemon answers such a wake `gone`, the endpoint throws `NothingAsleep`, the control plane clears the flag and lists why ("what it saved is gone: shown again, it starts afresh") |
| 3 | The window's "Resume conversation" builds its tile in the window and never calls `agent.start`, so it passes the two-process guard | Built: the guard moved to where every start passes, `Terminals` (`conversationAsleep`), one rule in the control plane shared with `agent.start`'s early answer |
| 4 | The browser phone (`crates/hive-web`) is a third phone surface, missing from the plan | Step 7 widened (piece 6) |
| minor | An agent ending by itself before its screen is read is saved without the mark; `markAsleep` racing a restore; removing a workspace ends only this machine's sleepers; a participant cannot sleep their own agent in someone else's workspace | Built: the mark is written whenever a sleep was asked (`sleep-no-signals.test.ts`); the race leaves a mark on a live session until its next save, harmless (a wake restores it): accepted; other machines' sleepers of a removed workspace go at 90 days: ceiling; the participant limit is stated (theirs to run, so theirs to sleep from their own app) |

Found while building round 5: a sleep cleared the turn before the status said so, so the mailbox
never heard the turn end and held a woken agent's messages until its next turn. The mailbox now
owns the sleeper's state (asleep, waking) and the test drives it through the control plane.

## Pre-mortem (a year on, it failed)

1. **"Resume brought back a blank agent."** The transcript was pruned by the agent, or the agent
   has no resume rule. Changed: sleep refuses an agent with no `session.resume`; sleepers are
   kept 90 days by our retention; the restore's `vanished` check (runtime-manifest.ts) and retry
   banner on the tile. Ceiling: Claude deletes transcripts after
   `cleanupPeriodDays` (30 by default); past it the conversation is gone wherever we keep the
   screen. Upgrade: show the sleep's age on the tile, and warn past 25 days.
2. **"Two agents wrote one conversation."** Changed: only a `wake` attach restores; the session
   stays exited-and-sleeping in the manager until it is saved and marked; an attach meanwhile
   waits and is then answered `asleep`.
3. **"Sleeping a workspace killed a running task."** Changed: busy tiles are skipped unless
   `--force`, and listed in the answer.

Other ceilings: waking 50 tiles at once spawns 50 agents — paced by the existing spawn pacer, each
taking its resume time. A sleep takes the agent's own exit time (Claude: ~4.5 s at load 100) up to
15 s; the tile dims when the flag lands, after the save.

## Build order

1. Daemon `sleep` / `slept` / `screen{saved}`. **Done: ffd9de9, 9407ee0** (`tests/sleep.test.ts`,
   7 mutants).
2. Daemon: sleep mark + `wake`, group signals, retention exemption, `SessionInfo` kept — the same
   test file: a plain and a `noSpawn` attach are answered `asleep`, a `wake` attach restores; a
   child ignoring SIGHUP does not survive; a marked snapshot past retention stays.
3. `TileRecord.sleeping` + `WorkspaceStore.setSleeping` + the guest edit rule — store test (done,
   2 mutants; the value becomes the folder) and an edit-rules row.
4. Endpoint and backends (local daemon, `hive host`, ssh daemon, devices) — a host test driving
   `Terminals` over a real daemon: sleep ends the process, the exit says slept, `terminal.saved`
   gives the screen, an attach is answered asleep.
5. Control plane `sleepTiles/wakeTiles`, `control.slept`, `agent.sleep/agent.wake`, `hive ctl
   sleep|wake` — ctl tests over the drive socket (tile/frame/workspace targets, busy skip,
   a slept exit keeps the spawn record, `--json` shape).
6. Window: `SleepingTile`, quiet slept exit, menus, Layers — unit test of the screen-to-HTML step;
   e2e specs listed for the coordinator.
7. Phone: `sleeping: true` in `agentsOf` and the phone core; Wake on the rows (Android, iOS, the
   browser phone).
8. Bench (`bench-sleep.ts`): 5 real agents, RSS of their trees before / after, no descendant left,
   Resume continues the conversation (the agent recalls a word given before sleep).

## Unknown

- Wake latency for a large transcript. Check: the bench times wake → prompt.
- Whether an MCP server that starts its own session (`setsid`) escapes the group kill. Check: the
  bench lists every descendant of each agent before sleep and checks each pid after.
- iOS cannot be built on this Linux machine. Check: the Swift change is kept to the row's label
  and one action, and listed for the coordinator to build.
