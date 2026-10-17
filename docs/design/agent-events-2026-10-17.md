# An agent's hook event in microseconds

Status: accepted after one review round, 2026-10-17. Building.

## Verdict

Cut the work at its source, then keep every derived answer until what it came from changes:

1. The hook process keeps only the payload fields the host reads, so the daemon never parses a
   tool's output. The host names the fields, per hook entry; `hive-net hook` only applies the list.
2. Every hook of ours runs native where hive-net is: the session tracker and the turn's reply too
   (a manifest `reply:` field path on `emit: turn.ended`), so no turn starts a 64-100 MB runtime.
3. Main answers "which agent is this tile" from a memo keyed on the store's core identity, with a
   tile index, and records sessions in memory: no per-event folder of boards, no per-event file read.
4. A tile's transcript is looked up when its status changes, not every second, and what its file
   says it waits on is kept until the file grows.

## Problem

**Goal.** An agent's hook event (every tool call, turn start and end, permission ask) costs
microseconds on Electron main and on the pty daemon, whatever the tool's output size and however
many agents run.

**Constraints.**
- The app, `hive host`, the daemon and hive-net ship as one release (CLAUDE.md, "Release
  management"). The hook protocol may change; no old-app shims.
- What a hook says stays the host's: hive-net carries no knowledge of agents or events
  (spec/hook-protocol.md, commit 134673d).
- Windows has no native hook; its script parses in the hook's own process and stays as is.
- Manifests are published from the plugins repository (HiveHub). A manifest change here is a
  change there; `tests/fixtures/published-agents` mirrors it.

**The path today**

```
agent ─exec─▶ hive-net hook ──{env, stdin: whole payload}──▶ door (pty daemon thread)
                                                              JSON.parse(line) + JSON.parse(stdin)
                                                              ──agent.event──▶ hcp.sock (main)
main: ControlPlane.event ─▶ writeTrackedSession (read file) ─▶ StatusStore ─▶ subscribers:
      signalsTurns/steers ─▶ manifestOf(heldBoards(store))      (every working edge)
      push.changed ─▶ boards() + decides ─▶ heldBoards ×2         (needs/done edges)
      agent feed / agent list ─▶ agentsOf: agentOf + manifestOf per agent, each scanning every board
      askingOf ─▶ readTrackedSession + readdir ~/.claude/projects + 256 KB transcript read
conversations: followAgent ─ every 1 s ─▶ transcriptOf(heldBoards(...)) + session file read + readdir
```

Per turn of a Claude or Codex agent, `Stop` runs the agent's own `hive-turn-end.cjs` under
Electron-as-node; per session start, Claude and Kiro run `tile-session-tracker.cjs` the same way.

**Measured before** (bench scripts in the session scratchpad `bench/`; 16 CPUs):

| What | Load | Number | Bench |
|---|---|---|---|
| Door CPU per hook, stdin 100 B / 100 KB / 1 MB / 4 MB | 79 | 4.5 / 5.2 / 31 / 142 ms | `door2.mts` |
| Main per hook event, 72 agents (6 workspaces) / 600 (50) | 73-100 | 1.9 / 1.8 ms | `main-event.mts` |
| Agent list build, 72 / 600 agents | 73-100 | 17.6 ms / 1,599 ms | `main-event.mts` |
| `heldBoards`, 6 / 50 workspaces | 77 | 0.46 / 2.9 ms | `held.mts` |
| JS hook process (tracker) | 85 | 0.45-0.93 s wall, ~100 MB max RSS | `/usr/bin/time` |
| Native hook process | — | measured in step 1 | `/usr/bin/time` |

Where main's 1.9 ms goes (CPU profile, inclusive shares of `ControlPlane.event`): status
subscribers 68% (push notice and turn signal through `heldBoards`, of which `ownership()` reads
from the Loro document are most), `writeTrackedSession` 22% (a file read on every event that
names a session).

The agent list is quadratic: `agentOf` scans every board's tiles for each agent, and `manifestOf`
flattens every board's tiles into a new array for each of the four facts asked per agent.

**Known problem.** Edge filtering ("project at the source": send only the fields a consumer
reads) plus derived-data memoisation keyed on input identity (selectors), plus replacing polls
with change notifications.

## What others do

- cmux (manaflow-ai/cmux, `CMUXCLI+AgentHookPayload.swift`): its native hook CLI parses the hook
  input, keeps session id, turn id, cwd and transcript path, compacts it and caps it at 4 KiB
  before it reaches the app. Teaches: filter in the hook's own process, never in the app.
- hapi (tiann/hapi, `hook-forwarder`): forwards the whole stdin to an HTTP hook server. Teaches:
  the simple path puts the parse on the server; fine for SessionStart only, which is all it uses it for.
- Claude Code hooks reference (code.claude.com/docs, via ctx7 `/pjbrito/claude-code-docs`):
  PostToolUse input carries `tool_input` and `tool_response` whole; `type: "http"` hooks post the
  same JSON with no process; `async: true` runs a command hook without the agent waiting.
  Teaches: the payload size is the tool's, unbounded; a processless hook exists for Claude only.
- Reselect / React `useMemo`: derived data recomputed only when its inputs' identity changes.
  Teaches: `WorkspaceStore.getCore` already returns the same frozen object until the workspace
  changes (store.ts:123), so identity is the cheapest valid cache key here.
- This repo's own rule (CLAUDE.md "Work that runs per event"): the owner keeps the result and
  clears it on change; a poll stops when its last follower leaves.

## Facts and dropped choices (trust-issues)

| Assumption | Bucket | Evidence |
|---|---|---|
| Payloads can be MBs (`tool_response`, `tool_input` of a Write) | Fact | Claude Code hooks reference; door MAX_LINE 4 MB |
| The host reads ~6 top-level fields of a payload | Fact | hook-lines.ts: `session_id`, `agent_id`, `background_tasks`, `hook_event_name`, `tool_name`, `tool_input` (answer only) |
| hive-net hook is a pipe with no logic of its own | Choice (134673d) | Kept in spirit: it applies a list the host renders, and knows no field by name |
| Each hook sends the whole stdin | Habit | Nothing reads past the fields above |
| The tracker must be a script | Habit | It writes one file; the door can (it is in the daemon, like the script's writes) |
| A turn's reply needs plugin code | Choice | Claude's and Codex's scripts read one field (`last_assistant_message`) |
| `heldBoards` must be recomputed per call | Habit | Cores are cached and identity-stable (store.ts:115-131); ownership lives in META, which `partsChanged` counts as core, so it never changes without a new core |
| Session is checked every second | Habit | ca0a4a8 needed "follow into a new session"; a session only changes on a hook event or a spawn, both status changes |
| Every event re-reads the tile's session file | Habit | `writeTrackedSession` read-compares; the plane can remember what it wrote |

Dropped for the coordinator to confirm: the whole-stdin pipe, the script tracker, the turn-end
scripts of Claude and Codex (they become manifest data), the 1 s session poll.

## Options

**A. Boring: caps and caches only.** Door refuses a line over 64 KB (the event is lost or sent
without ids), main caches `heldBoards` for 250 ms.
```
hook ─whole stdin─▶ door (cap 64 KB, else drop) ─▶ main (TTL cache)
```
Breaks at once: a big tool output loses its session id, so a status edge is missed; a TTL cache
serves a stale board for 250 ms after a tile moves. A cap is the symptom fix.

**B. Chosen: project at the source, memo on identity, events not polls.**
```
hook ─HIVE_EVENT_KEEP=session_id,agent_id,…─▶ hive-net: parse, keep those keys ─{env, stdin: ~200 B}─▶ door
door ─▶ (tracker: write tile session) | agent.reply then agent.event ─▶ main
main: plane.sessions (memory) ─▶ StatusStore ─▶ heldBoards memo (core identity) + tile index
transcripts: (tile, session, boards) memo; missing file re-looked-up on the tile's next status change
```
Breaks: the payload of an answering entry still carries `tool_input` whole (a Write of 4 MB asks
permission: one 4 MB parse, at human pace).

**C. Bold: no process per hook.** Claude's `type: "http"` hooks post to a daemon endpoint.
```
claude ─HTTP POST whole JSON─▶ daemon :port (token header) ─▶ main
```
Breaks: only Claude has it (Codex, Droid, Kiro, Hermes are commands); the daemon parses the whole
body again (back to 142 ms at 4 MB); a TCP port on localhost is open to every local user, where
the hook door is a 0600 socket.

**D. Spool file (cmux's non-decision path).** Hooks append to a private file with shell builtins;
one reader forwards. One `sh` per hook, no runtime, but `sh` cannot filter JSON, so the reader
parses whole payloads, and answers need a second path.

**Scale.** Today: about 10 agents, a tool call every ~5 s each, so ~2 hooks/s on average and
bursts of ~20/s. 10x: 100 agents, ~20/s, bursts 200/s. 100x: 1000 agents, ~200/s, bursts 2000/s.
Payload p50 ~2 KB, a big tool output 1-4 MB, say 1 in 50 hooks.

| Design | Today | 10x | 100x |
|---|---|---|---|
| Now | door 20 hooks/s × (4.5 ms + 2% × 142 ms) ≈ 150 ms/s = 15% of the daemon thread; main 20 × 1.9 ms = 38 ms/s | 1.5 s/s: daemon saturated, terminals stall | — |
| A | door ≈ 20 × 4.5 = 90 ms/s; ids lost on big outputs | 900 ms/s | — |
| B | door ≈ 20 × e_d; main ≈ 20 × e_m (both to be measured, target ≤ 50 µs) ≈ 2 ms/s | 20 ms/s | 200 ms/s on each thread: the first ceiling |
| C | Claude only; daemon parse as now | as now | as now |

Arithmetic: per-second thread time = hooks/s × per-hook cost. 4.5 ms is the door's fixed cost at
100 B (two connections and a parse under load 79); 142 ms the 4 MB case; 2% the big-payload share.

## Choice

B. A loses events. C covers one agent of seven and puts the parse back on the daemon. D still
parses whole payloads. B's limit is the per-event constant, not size or count.

What was surprising: the 4.5 ms door cost at 100 B, before any big payload, and that main's cost
was flat from 72 to 600 agents (the file read and the per-workspace ownership reads, not the
agent count, set it), while the agent list was quadratic.

## Design

1. **What a hook keeps** (packages/hive-agents `events.ts`, `hooks.ts`; crates/hive-net `hook.rs`).
   `keptFields(entry)` names the payload's top-level keys the host reads for an entry: the event's
   ids always (`session_id`, `agent_id`, `background_tasks`), and `hook_event_name`, `tool_name`,
   `tool_input` for an entry that answers, and the first key of `reply`. `HIVE_EVENT_KEEP` carries
   it: the ids list in every hooked agent's spawn environment, and a longer list in the command of
   an entry that answers or names a reply (no stable agent's command text changes, so Hermes is not
   asked again). hive-net parses only the top level, each value kept unparsed, and sends `{env,
   stdin}` with those keys; stdin it cannot parse goes whole, as today, so no id is lost. The script
   ignores it (it parses in its own process).
2. **The tracker, native.** Where hive-net is, `tracker` runs `hive-net hook` with
   `HIVE_EVENT_KEEP=session_id` and no event; the door writes the tile's session
   (`writeTrackedSession`) for a connection with a session and no event. The door takes the
   sessions folder from the daemon (`startHookDoor({ tileSessionsDir })`: one argument in
   pty-daemon.ts, track 1's file).
3. **The reply, native.** An `emit: turn.ended` entry may name `reply: <field path>` (validated:
   a field path, `launch.hcp`, which already discloses the control plane). `hookLines` then says
   `initialize` with the hook's own token, `agent.reply` as a notification, then the event, on one
   connection: main hands a signed-in connection's notifications to the plane in order and at
   once (hcp-server.ts:76, plane.ts:344), so the reply is in before its turn ends, with no round
   trip and no wait on `ready()`. The standalone daemon's control socket accepts the same
   notification once signed in (pty-daemon.ts, track 1's file). The reply is cut to 256 KB.
   Claude's and Codex's `Stop` become `emit: turn.ended, reply: last_assistant_message`; their
   `hive-turn-end.cjs` goes (plugins repository too).
4. **Boards held, by identity** (packages/host `needs.ts`). `heldBoards(store)` returns the same
   array while `repos()` and each `getCore(repo)` are the same; a tile index per array answers
   `agentOf`, `manifestOf`, `runsIn` and the agent's board in O(1). The agent list becomes
   O(agents).
5. **Sessions in memory** (`control/plane.ts`). The plane remembers the session it last recorded
   per tile and writes only a new one; it forgets it when the session exits (its daemon evicts the
   file then) and when the tile goes. A session id is checked (`isSessionId`) where it is parsed,
   written and read: today any string up to 256 characters reaches `--resume <id>`.
6. **Transcripts on events** (`conversations.ts`, `conversation.ts`). Where a session's file is
   (`sessionFile`, a folder scan) is kept once found: a session's file does not move. `followAgent`
   re-checks when anything is heard of its agent (a hook event or a status change), not every
   second; while its file is missing that is every hook event, so Claude's first file, written
   during the first turn, is found at the turn's first tool use. `pendingTool` is kept per file
   until its size or mtime changes.
7. **Push subscriptions in memory** (`push.ts`). Read once; the class is the file's only writer.

## Review (fresh reviewer, round 1) and answers

1. *Reply after its turn end* when the script sends all lines and main answers `agent.reply` after
   `ready()`. Taken: the reply is a notification after `initialize` (step 3).
2. *serde refuses a lone surrogate or a cut emoji, losing the session id.* Taken: top-level parse
   with raw values; whole stdin when even that fails (step 1).
3. *A session id can carry a flag into `--resume`* (exists today). Taken: `isSessionId` at parse,
   write and read (step 5).
4. *`HIVE_EVENT_KEEP` in stable command text re-asks Hermes users.* Taken: ids list in the spawn
   environment (step 1).
5. *The plane's session memory goes stale* (the daemon writes at spawn and evicts on kill).
   Taken: forgotten on exit and on forget; the standalone daemon's own per-event read is track 1's
   file and is listed for them.
6. *Claude's first transcript file is missed for the whole first turn.* Taken: re-check on every
   hook event while the file is missing (step 6).
7. *Cost model*: the door's 4.5 ms at 100 B is a fixed cost B keeps; the agent list, `askingOf`,
   push encryption and the standalone daemon's `notifyPush` were left out. Answer: steps 4, 6 and 7
   remove the list's quadratic part, `askingOf`'s scan and the push file read; the door's fixed
   cost is measured on its own once hive-net is built (accept, connect, two small parses), and a
   long-lived door-to-main connection is the next step if it is the connect. Encryption runs per
   phone per needs/done edge only. "Flat in agent count" is claimed for the per-event path; the
   list stays O(agents) per rebuild (ceiling below).
8. *`reply:` needs limits.* Taken: validation, the hook's own token (never the daemon's), 256 KB.
   No new disclosure line: `launch.hcp`, which `reply` requires, has one.

Checked and sound: the memo (every change to ownership, a tile's command, arguments or frame
gives a new core); the kept fields (`asks`, `chosen`, `leave` read inside `tool_input`).
Also taken: the tile index holds tiles, never manifests (the catalog can change without a core).

## Pre-mortem

1. *A field the host reads is not kept, so status breaks for one agent.* The conformance table
   (`agent-event-hook.test.ts`) runs every case through the script and the native hook; it fails
   when the kept list drops a field the script used. `keptFields` and `hookLines` sit side by side
   with a test that a kept payload gives the same lines as the whole one.
2. *The memo serves a stale board.* Its key is the store's own invalidation (a new frozen core per
   change). A test changes a tile's command and its owner and asserts the next answer sees it.
3. *A conversation never follows a session that began without a status change.* A new session
   comes with `session.started` (Claude, Codex, Droid) or the tracker; both change the status
   (`session` is in it). Kiro reports only through its tracker: the door's write is not an event,
   so its conversation would not follow a `/clear`. Kiro keeps no conversation the phone reads
   (no `session.transcript`), so this is a written ceiling, not a bug today.

## Build order

1. hive-net keeps the named fields; `keptFields` + `HIVE_EVENT_KEEP`. Check: hive-net tests, the
   conformance table through both hooks, door bench flat from 100 B to 4 MB.
2. Door writes the tracker's session; `tracker` native. Check: a test runs the tracker through
   hive-net and finds the file; JS fallback unchanged.
3. `reply:` on emit entries, door's reply-then-event; fixtures for Claude and Codex. Check: `hive
   ctl read` path test (`turns.lastReply`) through the native hook; manifest validation tests.
4. `heldBoards` memo + tile index. Check: needs tests, a staleness test, `main-event.mts` before
   and after, agent list at 600 agents.
5. Plane session memory. Check: plane tests, profile share gone.
6. Transcripts on change. Check: conversation tests (follow into a new session), askingOf memo.

## Known ceilings

- The memo's key check is O(workspaces) (a `repos()` copy and a map lookup each): ~µs at 50. A
  store version number would make it O(1); that is `WorkspaceStore`'s (track 2).
- An answering entry keeps `tool_input` whole: one parse of the tool's input per permission ask.
- The agent list is still rebuilt whole per change (O(agents), throttled to 4/s by the feed). The
  upgrade is an item per agent, rebuilt on that agent's change.
- Each conversation caller keeps its own file watch and 1 s stat poll (audit-broadcast #12).

## Unknown

- hive-net hook's own start time and RSS on this build (step 1 measures).
- Whether Codex's Stop payload names its reply `last_assistant_message` in every version: its
  script reads that field today, so the manifest change says no more than the script did.
