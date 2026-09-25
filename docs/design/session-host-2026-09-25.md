# Session host — the daemon owns screens and status; the renderer draws what is shown

Status: design, 2026-09-25. Branch `feat/agent-events`.

## 1. Summary

1. Renderer cost must scale with the terminals on screen, not with the terminals that exist.
   Today every terminal streams into a renderer xterm, and Chromium restyles, lays out and
   paints all of them — hidden ones most of all (§2).
2. The renderer's xterm is also the only place status is read (`readScreen` → detect rules), so
   a hidden terminal cannot stop streaming without going dark. The two problems are one.
3. The fix: the **daemon** — which already keeps a headless xterm per session, fed every byte,
   and already loads the agent catalog — reads the screen and runs the detectors. **Main**
   holds the one status store (screen status + canonical hook events + waits + exit). The
   renderer mirrors it, receives pty bytes **only for visible terminals**, and disposes a
   hidden terminal's xterm, re-creating it from the daemon snapshot (a path that already
   exists for reloads) when it is shown again.
4. Status then works with no window, for remote machines identically (a remote daemon runs the
   same code), and for views and `hive ctl` from one place.

## 2. Evidence

Profiled 2026-09-25, 100 terminals streaming agent-like output (spinner every 0.4 s + bursts),
CDP CPU profile + main-thread trace of the renderer (xvfb; relative numbers are what count):

| | Renderer CPU | Style+layout | All JS (xterm + ours + React) |
|---|---|---|---|
| Canvas, all shown | 62–64 % | 22 % | 4 % |
| All parked (a view that shows none) | 74–77 % | 41 % | 9 % |

xterm's JavaScript is not the cost; the browser lifecycle over hundreds of live terminal DOMs
is. Skipping rendering of parked surfaces alone took the parked case to 30 %; not having those
xterms at all removes the rest (parse + DOM + memory).

## 3. What exists (from the code, feat/agent-events)

- Renderer detection: `readScreen()` (visible rows, trimmed) every 1200 ms when output arrived
  (`TerminalTile.tsx:335-343, 884-944`), `detectTileStatus` + `stabilizeClaudeStatus`
  (`agent-state.ts:35-85`), combined with hooks/waits/exit in `agent-status-bus.ts:73-114`.
- Daemon: one `@xterm/headless` + `SerializeAddon` per session, written on every chunk and
  resize (`pty-session-manager.ts:322-373, 469, 606`); catalog loaded (`pty-daemon.ts:192-210`);
  snapshot on attach (`serializeDrained`, `pty-session-manager.ts:284-294, 488-501`), `resync`,
  `event` messages to viewers; the same daemon runs remote (`remote/pty.ts:115-123`).
- Remount from a daemon replay already works (reload / StrictMode / view moves,
  `TerminalTile.tsx:215-220`).
- Detection is pinned by screen-text tests: detector golden (8041 screens), provider golden,
  agent-state tests.

## 4. Design

### 4.1 Screen watcher (shared, pure)

A `ScreenWatcher` over a headless terminal: `readScreen()` identical to the renderer's
(visible rows, trimmed, `\n`-joined), a dirty flag set by writes, a 1200 ms tick that runs the
agent's detector + `stabilizeClaudeStatus` when dirty, plus last-output time, OSC title, and
exit. Detection code moves from the renderer to `hive-agents` so daemon, main and tests share
one copy. It runs in the daemon for daemon sessions, and in main for the in-process pty host
(`HIVEMIND_PTY_DAEMON=0`, the win32 remote fallback), so there is no mode without status.

### 4.2 Protocol

`{ t: "status", id, screen: TileStatus, at, title? }` from daemon to viewers that asked for it
(the `events` capability already gates hook events), only on change. The local endpoint gets
`onEvent`/`onStatus` too (today only remote passes `onEvent`, `daemon-client.ts:151`).

### 4.3 Status store in main

One reducer per tile over: screen status (4.1), canonical agent events (hooks, `agent.event`),
wait overrides, notify, subagent count, exit — the precedence of `agent-status-bus.ts:73-114`
moved verbatim into a pure module with its tests. It keeps `since`, a source per value
(hook | screen | wait | exit), and history for the ledger. Main pushes changes to the
renderer, whose status bus becomes a mirror; views, `hive ctl list`, notifications and the
1.3 hub read the same values. `clearStatus` on unmount goes away — a tile's status lives as
long as its session.

### 4.4 First-prompt delivery

The typed-prompt path (`TerminalTile.tsx:898-922`: wait for two quiet ticks, type, backstop
Enter while idle) moves to main, driven by the store's status and the work queue, so a
hidden agent still gets its first prompt. Argv-delivered prompts are unchanged.

### 4.5 Interest

The renderer reports which tiles are shown (adopted by a visible slot). Main:
- keeps every session attached (the control-plane recorder and `agent.stream` stay fed);
- forwards pty bytes to the renderer only for shown tiles;
- on show, sends a fresh snapshot (a new `snapshot` request, no detach/attach cycle).
The renderer disposes a hidden terminal's xterm after a grace (30 s) and re-creates it from the
snapshot when shown. Title updates and send-to-agent registration move off the xterm
component so they survive.

## 5. Milestones

| # | Change | Gate |
|---|---|---|
| M1 | Detection to `hive-agents`; `ScreenWatcher`; daemon runs it; `status` protocol message; main receives it (logged beside the renderer's result) | detector + provider goldens unchanged; a parity test feeding the same bytes to a headless terminal and asserting the same statuses as today's renderer path |
| M2 | Status store in main (precedence moved with its tests); renderer bus mirrors it; `hive ctl list` / views read it | `agent-status-bus` tests ported green; e2e status specs green; hidden tiles keep status |
| M3 | First-prompt delivery in main | first-prompt e2e green with the tile hidden |
| M4 | Interest: mute/unmute in main, snapshot request, dispose hidden xterms after grace | view-switch/windows/community/unseen-terminal e2e green; typing latency unchanged |
| M5 | Re-profile 100 terminals; renderer cost should track visible terminals | profile script before/after, recorded here |

Out of scope: forking xterm.js (its JS is 3–9 % of renderer time), native rewrites (main 7–8 %,
daemon 5 % at 100 agents).
