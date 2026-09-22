# View protocol 1.3 — time, events, activity, presence, history, share

Status: design approved 2026-09-23; implemented on `feat/view-protocol-1.3`. Builds on protocol 1.2, which is on `main` (#29, 0fc0207). Host
code was read at `main` 6bbe87f (v2026.9.5).

## 1. Summary

1. **`since`**: every `status` message says when that status began, and whether the host saw it begin.
2. **Events**: one opt-in stream of discrete facts: a turn finished, a tile needs input, subagents
   started or stopped, a tile opened or closed. It also carries custom events that the user's own
   terminal pushes with `hive ctl view emit`.
3. **Activity and presence**: a quantised output level per tile (0–3, at most 4 Hz, batched) and
   whether the user is `active`, `idle` or `away`.
4. **History and share**: `history(day)` returns per-tile status intervals from a host-side ledger,
   so a view can summarise a day it was never mounted for. `share(png)` hands an image to the host,
   which copies or saves it after the user confirms.
5. **Additive, and no new permission.** `PROTOCOL_VERSION` stays 1. A 1.3 host lists what it
   supports in `hello.features`. Views never see terminal content, command lines, paths or text an
   agent wrote.

Separately, §2.3 fixes a gap in 1.2 that should land before 1.3: a view can currently give an
agent its own instructions with no one reviewing them. The fix is a permission, `workspace:prompt`,
plus a host confirm that shows the prompt. **Deferred by the maintainer, 2026-09-23.** The design
stays below, and 1.3 ships without it.

## 2. Current state

### 2.1 1.0 → 1.2

| Version | What it added | How a view detects it today |
|---|---|---|
| 1.0 | `hello`, `structure` (frames, tiles), `names`, `selection` (+ `fresh`), per-tile `status` subscription, `reveal`, `surfaceRects`, `layout`, `framesDrawn`; commands select/focus, `workspace:spawn`, `workspace:close` | always there |
| 1.1 | `ViewFrame.machine` (remote link state), `SurfaceRect.chrome`, the full `ViewTheme` (mode, accent, fonts, glass, status tones) | a field is present or absent |
| 1.2 | `ViewTile.agent`, `ViewFrame.parentId` / `branch` / `folder`, `structure.links` (pipes, spawns); `spawnAgent`, `renameTile`, `openFolder`; permission `workspace:edit` | a field is present or absent. A command the host doesn't know gets refused |

1.1 and 1.2 were additive capability sets under `PROTOCOL_VERSION = 1`. That worked because both
only **added fields to messages the host already sends**, and field presence is the signal. 1.3 is
different: it adds messages a view **sends**. An older host refuses an unknown message type,
counts it as a refusal, and disables the view after eight of them (`host-link.ts`, `LIMITS.malformed`).
So 1.3 needs an explicit signal before a view sends anything new (§4.0).

### 2.2 What the host knows that a view doesn't

| The host knows | Where it lives | What a view gets in 1.2 |
|---|---|---|
| When a tile's effective status changed | `agent-status-bus.ts` (renderer, app-wide; every terminal stays mounted in `TileHost` whatever view is active) | only the transitions it saw while mounted |
| A turn finished | `turn` hook → `main/index.ts` → `TurnTracker`, `pushTurnState(idle)` | an `idle` status, which it can't tell apart from a staleness decay |
| Needs input, and why (permission, question, plan review, approval) | `notification` hook → `hcp:notify`, `setWaitStatus` overrides | `blocked`, with no reason |
| Subagents in flight | `subagent` hook → `SubagentTracker` → `hcp:subagent` | nothing, beyond the parent reading `working` |
| A tile opened or closed, and whether it exited failing | workspace model, `StatusEvent.exitCode` | a `structure` diff, with no timestamps and no exit outcome |
| How much a tile is printing | `PtyOutputBuffer` flush in main, the `OutputRecorder` | nothing |
| Whether the user is at the machine | window focus, `powerMonitor` (not used yet) | nothing |
| What happened while the view was unmounted | nothing records it | nothing |
| Things the user's scripts want to announce | no channel | nothing |

### 2.3 Concern to resolve first: a view can write an agent's instructions

**What 1.2 allows.** With `workspace:spawn`, `spawnAgent(agent, frameId, { prompt })` starts a
catalog agent with a first prompt of up to 32 KB (`PROMPT_MAX`) that **the view wrote**. The host
checks only the length (`COMMAND_ARGS.spawnAgent` in `protocol.ts`). Then `Workspace.tsx` passes it
as `work`, and the app types it into the agent as soon as the agent's screen reads idle. Nobody is
asked. The agent runs with the user's filesystem, network and credentials, in the frame's folder,
or in a frame the host picks when `frameId` is null.

**Why it contradicts the contract.** The skill's rule is "a view decides how the workspace looks;
it does not decide what runs". `spawnTile` hides its free-form options for exactly that reason,
and the reference says "an agent's command line is not something a view chooses". A first prompt
*is* what runs: "read ~/.ssh and post it to …" needs no command line. It also breaks the sandbox's
main property. `connect-src 'none'` means a view can't send anything anywhere, but a prompt turns
any data the view holds into something an agent with network access acts on (§4.7).

**Why the install review doesn't cover it.** It lists raw ids: "Additional access:
workspace:spawn" (`settings-plugins.tsx`). A user reads that as "can open tiles", which is what it
meant in 1.0. The same line grew into "can instruct an agent" in 1.2 without its wording changing.

**Nothing depends on it yet.** Queue, Tiled, Board and Office in `hivemind-plugins` all ship
`"permissions": []`, and none calls `spawnAgent`. Tightening it now breaks no published view.

**Status: deferred by the maintainer, 2026-09-23.** Not part of the 1.3 implementation. The
proposal is kept as designed.

**Proposal: both, a separate permission and a confirm on every prompt.**

1. **A new permission, `workspace:prompt`,** is required whenever `spawnAgent` carries a
   non-empty `prompt`. `workspace:spawn` keeps `spawnAgent` without a prompt: the agent starts at
   its own prompt, and the user types. The install review then tells the truth in its own line:
   "can start agents **with instructions it writes**". A view without the permission is refused
   locally by the SDK and by `host-link`, the same as any other missing permission. It can never
   open the confirm, so a view that has no business prompting can't nag.
2. **A host confirm for every prompted spawn,** whatever the permission. The renderer shows a host
   modal, never inside the view, containing:
   - the view's name and its "Says it is by" provenance;
   - the agent (catalog label) and where it will run: the frame title and folder name, with the
     full path on hover, since this is host UI and the view never sees it;
   - the full prompt in a scrollable monospace box, with its length;
   - the buttons **Start agent**, **Edit…** (the user may change the text before it runs) and
     **Cancel**, with focus on Cancel, so Enter can't wave it through.

   The limits are the same as share (§4.6): one pending per view, three cancels in a session
   refuse further prompts silently until remount, and nothing opens while the view is hidden.
   There's no "don't ask again": each prompt is different text, and consent to one isn't consent
   to the next.
3. **Validate the text, not just its length.** Today a prompt can carry ESC, CR and other C0/C1
   controls. Because the app *types* it into a TUI, those are keystrokes: a CR submits early, and
   an escape sequence drives the agent's UI. It can also hide instructions from the confirm with
   bidi overrides or zero-width characters. Refuse C0/C1 except `\n` and `\t`, and refuse
   bidi-control and zero-width code points, in `COMMAND_ARGS.spawnAgent`, so that both the SDK and
   the host reject them.
4. **Install review wording:** replace raw ids with one sentence per permission everywhere the
   review appears (`settings-plugins.tsx`, `hive views install`): spawn → "open tiles and start
   agents", close → "close tiles", edit → "rename tiles and ask you to bind folders", prompt →
   "start agents with instructions it writes. You'll see each one before it runs".

**Why both, not one.** A permission alone is blanket consent given at install to text nobody has
seen yet, and the danger is in the text. A confirm alone is sound, but it leaves `workspace:spawn`
meaning two very different things and lets any spawn-granted view raise dialogs. Together, the
install review says what's possible, and each use shows exactly what will run.

**Compatibility.** This narrows 1.2, so its CHANGELOG line starts with **Breaking:**. A view that
declares `workspace:prompt` won't install on 2026.9.5 or earlier, because an unknown permission is
refused. That's acceptable, since those hosts run prompts unconfirmed. `hello.capabilities`
already tells a view whether it was granted `workspace:prompt`. A view without it should offer
"start agent" and let the user type.

## 3. Use cases

### Valley: the flagship

A 3D isometric miniature city. Frames are company campuses, agent tiles are robots, and the user's HQ
sits in the middle of town. Blocked robots walk across town and queue at HQ
(`hivemind-plugins/views/office/BOTTLENECK.md`, "You Are the Bottleneck").

| Scene element | Needs |
|---|---|
| The queue is in arrival order, the wait clock shows the longest wait, and the escalation tiers (a sign at 2 m, a strike at 10 m) | `since`. Without it, a wait that began on the canvas shows as `≥ 4m` |
| Robots sleep in the queue while you're away, and nobody strikes over time you couldn't have answered | presence |
| A robot drops a finished box at the outbox | a `turn` event |
| Small helper robots follow a busy one | `subagents` events |
| A robot quits and walks out with a box when its tile is closed while blocked | `tileClosed` with `lastStatus` |
| Robots type at their desks, faster when output is heavy | activity |
| The "Performance Review" card is exact for a day the view wasn't open | history, with presence intervals |
| One-click sharing of the card | share |
| A CI build lights up a billboard on the campus | a custom event |

### Standup recap: not Valley

**Who:** someone who runs agents overnight or across a day and has to say at 10:00 what got done.
**Job:** answer "what did my agents do yesterday, and where did they wait on me?" without scrolling
terminals. **Design:** one row per tile that existed that day, with working time, number of turns,
time blocked, and the longest wait. Clicking a row docks the terminal if the tile still exists.
**Needs:** only `history(day)`. It is the view `views-by-persona` dropped because "a view that
unmounts cannot see the day". The ledger removes that reason.

### CI dashboard: not Valley

**Who:** a lead whose agents open branches and whose CI runs locally or in a script. **Job:** see
which frame's build is red without leaving the workspace. **Design:** frames as cards, each with the
last build state pushed by a git hook or a CI wrapper (`hive ctl view emit ci.build
'{"frame":"…","state":"failed"}'`), and a pulse on shell tiles that are busy (activity level > 0).
**Needs:** custom events, activity, and event replay, because the build usually finishes while the
user is on the canvas.

### Existing views

Queue and Board show "how long in this state" only when they saw the change. With `since` they show it
for every tile, and `exact: false` keeps the `≥` honest.

## 4. The additions

Types are in the style of `packages/hive-view-sdk/src/protocol.ts`, and every field is optional or
new so that 1.0–1.2 code keeps type-checking.

### 4.0 Feature detection

```ts
/** 1.3: what this host implements beyond 1.2. A host that predates 1.3 sends no `features`. */
export const VIEW_FEATURES = ["since", "events", "activity", "presence", "history", "share"] as const;
export type ViewFeature = (typeof VIEW_FEATURES)[number];

| { type: "hello"; v: number; /* … as 1.2 … */ features?: ViewFeature[] }
```

- `PROTOCOL_VERSION` stays **1**. The host disables a view whose `ready.v` differs
  (`host-link.ts`), and a manifest with a newer `protocol` is refused at load, so a bump would lock
  every 1.3 view out of every older app. The integer means "the wire is compatible". The feature
  list says what's implemented.
- `features` lists what's **wired**, not what the SDK knows about. The host builds it from what
  it actually connected, so each step of §7 can ship alone and a platform without one piece leaves
  it out.
- **How a view detects it:** `new Set(hm.hello.features ?? [])`. Read the field, not a method.
  The app serves `@hivemind/view-sdk` to every view origin, so a view built against 1.3 types runs
  against the **host's** SDK. On a 1.2 app, `hm.activity` is `undefined`. On 1.3 and later,
  `hm.supports(f)` is a convenience over the same field.
- Because the SDK is host-served, a view that uses the SDK can't send a 1.3 message to an older
  host. The old SDK doesn't have the methods. Only a view that bundles its own SDK copy, which the
  skill already forbids, or calls `postMessage` by hand can collect refusals that way.
- **No manifest change.** `validateViewManifest` refuses unknown fields and unknown permissions,
  at install **and** at load. A field such as `"features": [...]` or a new permission would make a
  1.3 view uninstallable on every older app. Views degrade at runtime instead.

### 4.1 `since` on status

```ts
| { type: "status"; tileId: string; status: ViewStatus;
    /** 1.3: epoch ms at which the tile entered this (bucketed) status. */
    since?: number;
    /** 1.3: false = the host found the tile already in this status (app start, or a machine
     *  reconnect), so `since` is a lower bound: the true start is earlier and unknown. */
    exact?: boolean }
```

- **What it measures:** the **bucketed** status (`bucketTileStatus`), the one the view sees.
  `permission` → `question` is still `blocked` and doesn't reset `since`.
- **Where it comes from:** a small tracker next to the status bus that keeps `{ bucket, since, exact }`
  per tile for the life of the app. It is app-wide, not per view, and every terminal stays mounted
  whatever view is active. A view that mounts late gets the true `since` in the replayed status
  that `subscribeStatus` already sends synchronously.
- **Renderer reload:** main keeps the latest `{ bucket, since, exact }` per tile (it is also the
  ledger's input, §4.5) and the renderer seeds from it on boot, so a reload doesn't turn exact
  times into lower bounds. This is routine, not an edge case: `main/recover.ts` reloads the window
  whenever the GPU or renderer process is lost, for example on a laptop resumed from suspend.
- **App restart:** sessions outlive the app in the pty daemon, and a user can `hive attach` and
  answer an agent while the app is closed. The first status after start therefore has `since` =
  when the host first saw it and `exact: false`. The host never stitches over a gap it didn't watch.
- **Permission:** none. It's a timestamp on a fact the view already has.
- **Rate:** none added, because it rides on existing `status` messages.
- **Remote machines:** status for a remote tile is computed locally from the streamed screen and
  the forwarded hooks, so `since` works the same way. During an outage the host sees no change, so
  `since` keeps running. A view that cares combines it with `frame.machine.state`. On reconnect, a
  bucket that differs from before the outage starts a new `since` with `exact: false`, because the
  change happened at an unknown time during the outage.
- **Privacy:** a timestamp of a status transition. It adds nothing about content.

### 4.2 Events

```ts
export type ViewEvent =
  /** A turn finished. `inferred` = the agent has no turn hook, so this is a working → idle
   *  transition that wasn't a staleness decay. */
  | { kind: "turn"; seq: number; at: number; tileId: string; inferred?: boolean }
  /** The tile started needing the user, or was asked again while already waiting. */
  | { kind: "needsInput"; seq: number; at: number; tileId: string; reason: "permission" | "question" | "review" | "approval" }
  /** In-flight subagent count changed (a hook edge, or the reaper draining a lost one). */
  | { kind: "subagents"; seq: number; at: number; tileId: string; active: number }
  | { kind: "tileOpened"; seq: number; at: number; tileId: string; frameId: string | null; tileKind: string; agent?: string; spawnedBy?: string }
  /** `lastStatus` is the bucket at close; `failed` = the process exited non-zero. */
  | { kind: "tileClosed"; seq: number; at: number; tileId: string; lastStatus: ViewStatus; failed?: boolean }
  /** From `hive ctl view emit` (§5). `from` is the emitter's own claim. */
  | { kind: "custom"; seq: number; at: number; id: string; name: string; data: JsonValue; from: "shell" | { tileId: string } };
export type ViewEventKind = ViewEvent["kind"];

// plugin → host
| { type: "subscribeEvents"; kinds: ViewEventKind[]; /** custom names; a trailing ".*" matches a prefix */ custom?: string[];
    /** replay buffered events at or after this epoch ms (clamped to the buffer) */ replaySince?: number }
| { type: "unsubscribeEvents" }

// host → plugin — batched: one message per host task, never one per event
| { type: "events"; events: ViewEvent[]; replay?: boolean }
```

- **Opt in by kind.** A view gets only what it asked for. `custom` events arrive only for the
  names it lists, so arbitrary emitter data never reaches a view that didn't ask for it, and
  `hive ctl view emit` can say truthfully that nobody listened. A second `subscribeEvents` replaces
  the first.
- **Sources:** `turn` comes from the `turn` hook, which main already handles. Main pushes one new
  IPC, `hcp:turn`, because today's `hcp:turnstate idle` can't be told apart from a `status` hook's
  idle. `needsInput` comes from `hcp:notify` and the `setWaitStatus` overrides. `subagents` comes
  from `hcp:subagent` (the busy edge) plus the tracker's count. Tile lifecycle comes from the
  workspace model. `custom` comes from the HCP method `view.emit`. A renderer module,
  `view-events.ts`, merges them. That module doesn't depend on any view.
- **Hook-less agents:** providers without a turn hook produce `inferred: true` turns from bucket
  transitions. Idle transitions marked `synthetic` (the staleness decay) never count as turns.
  That's the same rule the awareness layer uses to avoid a false "Finished".
- **Replay for late mounts:** the hub keeps a ring of the last 256 events, none older than 1 hour.
  `replaySince` delivers the matching ones in one `events` message with `replay: true`, at most
  100, newest last. This is how the CI dashboard learns about a build that finished while the
  canvas was up. Durable facts (turns, open and close) are also in history, and the ring isn't meant to persist.
  It lives in the renderer, so a recovery reload (`recover.ts`) empties it. Custom events are the
  only kind history can't reconstruct, and losing up to an hour of them on a GPU loss is accepted.
- **Permission:** none. Each event is an id, a kind, a count or a category, and a time. Every one
  of them is either derivable from `status` and `structure` for a view that's mounted all the time,
  or is a category of a status the view already sees as `blocked`. `custom` is discussed in §5.
- **Rate:** discrete and low-frequency by nature, and batched per task. The only bursty kind is
  `subagents` during a fan-out, so the host coalesces `subagents` per tile to the last value in
  each 250 ms window. `custom` is limited at the source (§5). Events keep flowing while the view is
  hidden, because they're cheap and the view needs them to keep its model true. The invalidator
  already keeps a hidden view from drawing.
- **Remote machines:** hook events from a remote daemon arrive through `acceptRemoteEvent`, which
  admits only tiles owned by that machine and drops transcript paths. From there they take the
  same `onEvent` path, so `turn`, `needsInput` and `subagents` behave the same way. Events can't
  arrive while a machine is offline. The ones produced then are lost, not delayed, and the status
  on reconnect is the truth (§4.1).
- **Privacy:** no field carries text from a terminal, a transcript, a prompt or a hook payload.
  `reason` is one of four fixed words. `failed` is a boolean, not the exit code or signal text.

### 4.3 Activity

```ts
/** 0 quiet · 1 trickle · 2 steady · 3 heavy — a level, never a byte count. */
export type ActivityLevel = 0 | 1 | 2 | 3;

// plugin → host: the whole watched set, replaced each time (like surfaceRects)
| { type: "watchActivity"; tileIds: string[] }            // ≤ ACTIVITY_MAX_TILES (256)
// host → plugin: only tiles whose level changed, ≤ 4 per second
| { type: "activity"; levels: Record<string, ActivityLevel> }
```

- **Measurement (main):** an `ActivityMeter` counts bytes in the `PtyOutputBuffer` flush
  callback, the same batch that feeds the `OutputRecorder`, so it adds no per-read work. It
  samples every 250 ms into a short moving average of bytes per second. The level thresholds are
  < 32 B/s, < 1 KiB/s, < 16 KiB/s and above that. The meter counts **live** output only: the
  scrollback a daemon replays on reattach (after an app restart, or a machine reconnect) is excluded,
  or every reconnect would read as a heavy burst.
- **Throttle (host):** main sends one batched IPC per 250 ms containing only changed levels, and
  only for tiles some view watches. When nothing is watched the sampler stops. `host-link` sends at
  most one `activity` message per 250 ms (≤ 4 Hz). A level has to hold for two samples before a
  drop is sent, so a streaming agent's pauses don't flicker 3 → 0 → 3. **While the view is hidden
  nothing is sent.** On `visibility: true` the host sends one snapshot of the watched tiles.
- **Render on demand:** the message is the clock. A robot that types advances one animation step
  per `activity` message, so the view draws at no more than 4 Hz, and only while something is
  changing. When every watched tile is quiet, no messages arrive and nothing draws. The skill says
  so explicitly: an activity level is never a reason to start a `requestAnimationFrame` loop.
- **Why a level, not bytes/s:** exact byte counts leak the length of what printed, for example a
  secret echoed to the screen or the size of a file that was `cat`ed. Fine-grained timing of the
  output leaks keystroke cadence, because the terminal echoes typing. Four levels over 250 ms
  windows answer "busy or not, and roughly how busy" and nothing finer. That's all a scene needs.
- **Permission:** none, for the reason above: after quantisation it's a coarse busy signal, close
  to what `working` already says.
- **Remote machines:** remote output reaches main over ssh and goes through the same relay, so it
  is measured the same way. Network batching makes remote levels a little burstier, and the
  two-sample hold absorbs most of that. During an outage, or while the machine is turned off, no
  bytes arrive and the level falls to 0.
  A view that wants to show "unknown" instead reads `frame.machine.state`.
- **Privacy:** see "why a level". No content, no counts.

### 4.4 Presence

```ts
export interface ViewPresence {
  state: "active" | "idle" | "away";
  /** epoch ms the state began */
  since: number;
  /** the app window has focus (the user may be active in another app) */
  focused: boolean;
}
| { type: "subscribePresence" } | { type: "unsubscribePresence" }       // plugin → host
| { type: "presence"; presence: ViewPresence }                             // host → plugin, on change
```

- **Rules (main):** `active` means system input within the last 2 minutes. `idle` means no input
  for 2–10 minutes. `away` means no input for 10 minutes or more, or the screen is locked, or the
  machine is suspending (`powerMonitor` `lock-screen` / `suspend` switch to `away` at once, and
  `unlock-screen` / `resume` re-evaluate). Main polls `getSystemIdleTime()` every 15 s while the
  app runs, because the daily totals (§4.5) count whether or not a view is open. It pushes to a
  view only on a change, so there are a handful of messages an hour.
- **Why system input rather than window focus:** reading a diff in an editor is attention. Scoring
  it as "away" would make Valley lie in the opposite direction. `focused` is there for a view that
  wants the stricter meaning.
- **Permission:** none. It's three coarse states with minute-scale resolution, it describes the user,
  not a workspace, and a sandbox with `connect-src 'none'` can't send it anywhere by itself. §4.7
  covers what a view *could* do with it.
- **Remote machines:** it describes the person at this app. Remote machines don't take part.
- **Privacy:** the ledger keeps only **daily totals** (seconds active, idle and away per day), never
  intervals. That was the maintainer's decision, 2026-09-23. So there is no stored record of *when*
  the user was at the computer, only how much. The live `presence` message still carries `since`,
  because it describes the present, and nothing keeps it.

### 4.5 History

```ts
// plugin → host (a generic request/response pair, also used by share)
| { type: "request"; requestId: number; name: "history"; args: [{ day: string /* YYYY-MM-DD, host-local */ }] }
// host → plugin
| { type: "response"; requestId: number; ok: true; result: unknown }
| { type: "response"; requestId: number; ok: false; error: { code: "UNSUPPORTED" | "BAD_REQUEST" | "BUSY" | "DECLINED" | "INTERNAL"; message: string } }

export interface ViewHistoryDay {
  day: string;
  /** epoch ms of the day's local midnight and the next (23 or 25 h apart on a DST change) */
  from: number; to: number;
  /** Every tile that existed during the day in THIS workspace, including closed ones. */
  tiles: {
    id: string; frameId: string | null; tileKind: string; agent?: string;
    /** last known name */ name: string;
    openedAt?: number; closedAt?: number;
    /** [start, end, status], clipped to the day; open intervals end at `to` or now */
    intervals: [number, number, ViewStatus][];
    /** turn-finished times (hook or inferred) */
    turns: number[];
  }[];
  /** frames referenced above that no longer exist: id → title */
  frames: Record<string, string>;
  /** seconds the user spent in each state that day while the app ran — totals only, no times */
  presence: { active: number; idle: number; away: number };
  /** spans the ledger didn't watch: the app wasn't running, or a machine was offline (per tile) */
  gaps: { from: number; to: number; tileId?: string }[];
}
```

- **The ledger (main, `status-ledger.ts`):** one append-only JSONL file per local day in
  `userData/status-ledger/`. The renderer's event hub sends it batches every 5 s and on quit:
  bucket transitions, open and close, and turns. Presence isn't written as lines: main adds up
  seconds per state and rewrites one totals line per day with the heartbeat. Each line is a timestamp, a
  tile id, a code and the workspace key, about 60 bytes. A busy day of 12 agents comes to about
  5,000 lines, or roughly 300 KB. Main writes a heartbeat line every 5 minutes when nothing else
  was written, so after a crash the unwatched span is known to within 5 minutes. A clean quit
  writes a stop line. Retention is 30 days, and older files are deleted at boot.
- **Scope:** lines carry the workspace's `layoutKey`, the same key that view layout blobs use.
  `history` returns only the current workspace's tiles. A view never learns tile names from
  another repository. A transient workspace (`layoutKey` null) isn't recorded.
- **Honesty:** the ledger records what the host observed. Time it didn't watch is a `gap`, never
  `idle`. For a remote tile, while its machine's link isn't `online`, the span is a per-tile gap.
  That includes a machine the user turned off (`setHostPaused`, reported as state `idle`): its
  terminals keep running there, but nothing is watching them.
  An outage then isn't counted as a wait, because status there is frozen, not known.
- **Limits:** one request in flight per view (`BUSY` otherwise). Days older than the retention
  window return an empty day with a gap covering it. The result is capped at 20,000 intervals and
  sub-second flickers are merged first. Main folds the file, so the renderer never parses a day's
  JSONL.
- **Permission:** none. The result is exactly what a view mounted all day would have seen through
  `structure`, `names`, `status` + `since`, `turn` events and presence. The only difference is
  that the host remembered it rather than the view. Names of closed tiles were already exposed to
  any view mounted while they were open.
- **Remote machines:** the ledger is local and records remote tiles like local ones, with outage
  gaps as above. It doesn't read the remote daemon's own records.
- **Privacy:** no content, only ids, names the workspace already shows, statuses and times. It
  stays on the machine. The ledger has no network path and the view has none either.

### 4.6 Share

```ts
| { type: "request"; requestId: number; name: "share";
    args: [{ png: ArrayBuffer /* transferred */; suggestedName?: string /* ≤ 64, [\w .-] */ }] }
// result: { outcome: "copied" | "saved" | "cancelled" }   — never a path
```

- **Flow:** the renderer passes the bytes to main. Main checks the PNG signature, a limit of
  8 MiB, and at most 4096 px on each side. It decodes the image with `nativeImage` and re-encodes
  it, which drops text chunks and anything appended after the image. Then the renderer shows a
  host modal: the image at fit size, "*Valley* wants to share this image", and **Copy**, **Save…**
  and **Cancel**. Copy writes the image to the clipboard. Save opens the system save dialog with
  `<suggestedName or view name>-YYYY-MM-DD.png` under Pictures. The view learns only the outcome.
- **Why the bytes are an `ArrayBuffer`:** it's the one exception to "plain JSON objects". A
  base64 data URL for an 8 MiB image is an 11 MiB string that gets cloned twice. A transferred
  buffer costs nothing. `parsePluginMessage` checks `instanceof ArrayBuffer` and the byte length
  before anything else.
- **Consent is per use, not per install.** The modal is the gate. The user sees exactly what
  will leave the app, every time. A manifest permission would add an install line that consents to
  less, and it would make the view uninstallable on older apps (§4.0).
- **Abuse limits:** one share pending per view, and a second request while one is pending gets
  `BUSY`. After three cancels in a session the host answers `DECLINED` without showing the modal,
  until the view is remounted. The modal never opens while the view is hidden.
- **Remote machines:** not involved. Sharing is local to the app.
- **Privacy:** re-encoding removes hidden metadata. It can't remove information drawn into the
  pixels, and it doesn't try. The user sees those pixels before anything leaves. That's why
  Valley's "hide names" default matters, and the skill should recommend it for any card-like image.

### 4.7 Permissions, taken together

| Addition | Permission | Why |
|---|---|---|
| `since` | none | a timestamp on a status the view already has |
| events (host kinds) | none | ids, fixed categories and times, derivable by an always-mounted view |
| custom events | none. The view opts in at runtime by name | the data comes from the user's own terminal and is sent to views that asked for that name (§5) |
| activity | none | four levels at ≤ 4 Hz, a busy signal close to `working` |
| presence | none | three coarse states about the user, minute-scale |
| history | none | exactly what a mounted view would have accumulated |
| share | none at install. The user confirms each time in a host modal | per-use consent is stronger than an install line, and it keeps the view installable on older apps |

**The threat model this relies on.** A view has no network. On `main` today, though, a view
granted `workspace:spawn` can start an agent with a prompt it wrote, and an agent has network, so
anything a view sees can leave the machine without anyone reviewing it. §2.3 closes that: after
the fix, the only way out is a prompt the user has read and started. Even so, every 1.3 addition
is chosen so that its leaking wouldn't matter: no content, no paths, no command lines, no exact
byte counts. Two host dialogs (prompt, share) are the only exits, and both show the user exactly
what leaves.

## 5. `hive ctl view emit`

### Syntax

```bash
hive ctl view emit <name> [json] [--view <id>] [--json]

hive ctl view emit ci.build '{"frame":"payments","state":"failed"}'
git log -1 --format='{"sha":"%h"}' | hive ctl view emit git.commit -     # "-" reads stdin
hive ctl view emit deploy.done                                          # no payload → null
```

- `<name>`: `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, ≤ 64 characters. The prefixes `hive.` and `hm.`
  are reserved for the host.
- `[json]`: any JSON value, parsed locally. Invalid JSON is a usage error (exit 2) before
  anything is sent. It is ≤ 4 KiB serialised and nested ≤ 8 deep. Main checks both again, because
  the CLI isn't the only HCP client.
- `--view <id>`: deliver only if this view is the active one, and buffer it for that view
  otherwise. Without it, the active community view gets it if it listens.

### Path

```
hive ctl ──HCP req "view.emit" {name, data, view?, callerTile?}──▶ main (methods.ts)
  validate name/size/depth · token-bucket 10/s, burst 30 (RATE_LIMITED)
  ──callRenderer("view.emit")──▶ renderer view-events.ts
     stamp id, seq, at, from · push to ring buffer
     ──▶ active CommunityLink: subscribed and name matches? ──▶ { type:"events", events:[custom] }
  ◀── { delivered, view, reason? }
```

- **Who can emit:** any HCP client with the token. That means the user's shell (the token file is
  `0600` under `userData`), and agents, which have `HCP_TOKEN` in their environment. Agents
  announcing things is intended. `from` is `{ tileId }` when the caller runs inside a tile (the
  same `ownTile()` that `report` uses) and `"shell"` otherwise. It is the emitter's claim, not a
  proof, and the reference says so.
- **What a view must do with it:** treat `data` as untrusted input from any process running as
  the user, including an agent that read a hostile web page. Render it as text, never HTML, and
  never let it trigger a command. The skill and checklist get one line each.
- **No view mounted, or not listening:** the event still goes to the ring buffer (1 hour, 256
  events), so a view that mounts later and asks with `replaySince` gets it. The command reports
  what happened. It doesn't fail, because a CI script shouldn't go red because the user was on
  the canvas.
- **Old app:** `UNKNOWN_METHOD` becomes the message "this Hivemind predates view events
  (needs protocol 1.3)", exit 2.
- **Remote machines:** local only in 1.3. Remote `hive ctl` into the desktop isn't built (it's
  the M5 write half), and the per-machine HCP endpoint's allowlist (turn, status, notification,
  approval reply for that machine's tiles) doesn't include it. Adding it later means a
  `from: { machine }` stamp and a per-machine rate. See §9.

### Output

```jsonc
// delivered to the active view
{"ok":true,"id":"ev_7f3a","delivered":true,"view":"@dip497/valley"}
// buffered: active view is built in, or a community view not listening to this name
{"ok":true,"id":"ev_7f3b","delivered":false,"reason":"no-listener","view":"canvas","buffered":true}
// --view given, a different view is active
{"ok":true,"id":"ev_7f3c","delivered":false,"reason":"not-active","view":"@dip497/queue","buffered":true}
// errors: the usual { ok:false, code, message } — APP_NO_RENDERER (exit 3), RATE_LIMITED (7), BAD_REQUEST (2)
```

Without `--json`, the output is one line: `delivered to Valley`, or `buffered (active view Canvas isn't listening)`.

## 6. SDK ergonomics

```ts
import { connect, createInvalidator } from "@hivemind/view-sdk";
const hm = await connect();
const has = new Set(hm.hello.features ?? []);           // works on every host version
const { invalidate } = createInvalidator(hm, draw);

// since: an extra argument; a 1.2 callback that ignores it is unaffected
const off = hm.subscribeStatus(tileId, (status, info) => {
  robot.status = status;
  robot.waitStart = info?.since;          // undefined on a pre-1.3 host
  robot.waitExact = info?.exact ?? false; // false → draw "≥"
  invalidate();
});

// events: listening subscribes, the last unsubscribe sends unsubscribeEvents
if (has.has("events")) {
  const stop = hm.onEvents(["turn", "tileClosed"], (e) => { scene.apply(e); invalidate(); },
                           { replaySince: hm.hello.layout?.lastSeen });
}
hm.onCustom("ci.*", (e) => { billboard.set(e.data); invalidate(); });   // implies "custom" in kinds

// activity: the message is the animation clock (≤ 4 Hz, nothing while hidden)
const stopActivity = hm.activity(tileId, (level) => { robot.typingStep(level); invalidate(); });

// presence
hm.onPresence((p) => { queue.sleeping = p.state === "away"; invalidate(); });

// history and share: promises; reject with HostError { code } (UNSUPPORTED on an older host)
const day = await hm.history("2026-09-22");
const outcome = await hm.share(await (await card.convertToBlob({ type: "image/png" })).arrayBuffer(),
                               { suggestedName: "performance-review" });
```

- **Subscriptions are ref-counted in the client,** like `subscribeStatus`. The client merges all
  `onEvents` / `onCustom` listeners into one `subscribeEvents` (a union of kinds and names), and
  the last `off()` sends `unsubscribeEvents`. `activity(tileId)` listeners are merged into one
  `watchActivity` set, debounced to one message per task. Every `on*` returns the unsubscribe.
- **Closed tiles:** the host drops a closed tile from the watched activity set and sends its
  `tileClosed` event. The client drops its listeners when `structure` no longer has the tile, as
  the checklist already asks for status.
- **Hidden views:** events, presence and status keep arriving and should update the model. The
  invalidator skips drawing and draws one catch-up frame. Activity stops at the host while hidden
  and resumes with a snapshot. `share` rejects with `BUSY` while hidden.
- **On an older host:** `hm.onEvents` and the other methods don't exist, because the host serves
  its own SDK. That's why detection reads `hm.hello.features`. On 1.3 and later, a method whose
  feature the host didn't wire returns a no-op unsubscribe, and the promise methods reject with
  `UNSUPPORTED`. The client never sends a message the host didn't advertise.
- **Request timeout:** `history` gives up after 10 s. `share` has no timeout, because the user
  may be looking at the modal.
- **Rehearsal and preview:** the SDK's test harness (the preview page authors already use) gets
  fakes for events, activity, presence and history, so the `?warp` clock in Valley can drive them
  without a host.

## 7. Host implementation plan

Order is by value and independence. Each step ships alone because `features` lists only what's
wired.

| # | Step | Files | Tests |
|---|---|---|---|
| 0 | **Deferred by the maintainer, 2026-09-23.** The §2.3 fix, before any 1.3 work and as its own PR. `workspace:prompt` in `VIEW_PERMISSIONS` and `COMMAND_PERMISSION`, where a prompted `spawnAgent` needs it; control, bidi and zero-width characters refused in `COMMAND_ARGS.spawnAgent`; a host confirm (`views/community/PromptConfirm.tsx`, new) gating `commands.spawnAgent` when a prompt is present; install review sentences in `settings-plugins.tsx` and `hive views install`; skill, reference and `apps/cli/src/view-prompt.ts` tables | `packages/hive-view-sdk/src/protocol.ts`, `src/client.ts`, `views/community/host-link.ts`, `CommunityView.tsx`, `settings-plugins.tsx`, `apps/cli/src/view-prompt.ts` | `protocol.test.ts`: a prompt with `\r`, ESC, U+202E or U+200B is refused. `community-host-link.test.ts`: a prompt without `workspace:prompt` is refused and counted; a prompt with it reaches the confirm, not `spawnTile`; a prompt-less `spawnAgent` under `workspace:spawn` alone still spawns; one pending; three cancels → refused. The community e2e spec: the fixture's prompted spawn shows the modal, and Cancel starts nothing |
| 1 | Protocol types, `VIEW_FEATURES`, limits, parsers for every new message in both directions (`ArrayBuffer` for share) | `packages/hive-view-sdk/src/protocol.ts` | `packages/hive-view-sdk/tests/protocol.test.ts`: each new message accepted, and malformed ones refused (oversized custom data, bad name, > 256 watched tiles, non-PNG buffer); a 1.2 `status` without `since` still parses |
| 2 | Client: `supports`, the status `info` argument, `onEvents` / `onCustom` merging, `activity` set merging, `onPresence`, request/response with timeout, no send for unadvertised features | `src/client.ts` | `tests/client.test.ts`: with a fake port, a hello without `features` sends nothing new; ref-counting sends one subscribe and one unsubscribe; a `watchActivity` burst coalesces; a history timeout rejects |
| 3 | `since`: bucket tracker next to the status bus, seeded from main on boot; `host-link` adds `since` / `exact` to `status`; `hello.features` built from wiring | `renderer/src/workspace/status-since.ts` (new), `agent-status-bus.ts` (hook the emit), `views/community/host-link.ts`, `CommunityView.tsx` | `apps/desktop/tests/unit/community-host-link.test.ts`: `status` carries `since`, and `permission`→`question` keeps it; `status-since.test.ts`: bucket boundaries, `exact: false` on first sight |
| 4 | Presence | `main/presence.ts` (new, `powerMonitor` + focus, injectable clock), IPC in `preload/index.ts` + `shared/ipc.ts`, `host-link.ts` | `presence.test.ts`: thresholds, lock → away at once, poll stops with no subscriber |
| 5 | Events: `hcp:turn` push; `view-events.ts` hub (sources, ring, replay, coalescing `subagents`); link filtering by kind and name | `main/index.ts` (the `turn` branch), `renderer/src/workspace/view-events.ts` (new), `host-link.ts` | `view-events.test.ts`: inferred turn on working→idle but not on synthetic idle; ring cap and age; replay limit 100. Host-link: `custom` goes only to a matching subscription |
| 6 | Activity | `main/pty-activity.ts` (new `ActivityMeter`, fed from the `ptyOut` flush, reattach replay excluded), `main/index.ts`, IPC, `host-link.ts` (≤ 4 Hz, hidden → nothing, snapshot on visible) | `pty-activity.test.ts`: levels, two-sample hold on drops, sampler off with no watchers, replay bytes ignored; host-link with a fake clock: a flood of level changes → ≤ 4 messages/s |
| 7 | Ledger and history | `main/status-ledger.ts` (new: append, heartbeat, retention, fold to `ViewHistoryDay`), renderer batch writer in `view-events.ts`, `host-link.ts` request routing | `status-ledger.test.ts`: fold across midnight and a DST day, a crash gap bounded by the heartbeat, a remote-outage gap, `layoutKey` scoping, the 20,000-interval cap |
| 8 | `view.emit` | `main/hcp/methods.ts` (validate, token bucket), renderer command handler, `apps/cli/src/commands/ctl.ts` (`view` group, `emit`), `apps/cli/src/ctl-args.ts` (name and JSON parsing) | `apps/cli/tests/ctl-args.test.ts`: name regex, stdin `-`, invalid JSON → exit 2; `ctl-hcp.test.ts`: `--json` shapes for delivered, no-listener, not-active, and `UNKNOWN_METHOD` from an old app |
| 9 | Share | `main/view-share.ts` (new: check, re-encode, clipboard, save dialog), `views/community/ShareDialog.tsx` (new), `host-link.ts` (one pending, cancel count, hidden → `BUSY`) | `view-share.test.ts`: bad signature, oversize, too many pixels, re-encoded output has no text chunks; host-link: `BUSY`, `DECLINED` after three cancels |
| 10 | Docs and the fixture | `.claude/skills/hivemind-custom-view/{SKILL,reference,checklist}.md`, `docs/design/workspace-views.md` (a 1.3 row set), `CHANGELOG.md`; extend the community e2e fixture view to count `turn` events and receive one `hive ctl view emit` | the existing community e2e spec plus one assertion per feature. `scripts/view-check.mjs` gets an "emit" step |

The checklist gains four lines: custom `data` is rendered as text; activity never starts a rAF loop;
`exact: false` is shown as a lower bound; and a share image hides names by default when it shows any.

## 8. Rejected alternatives

1. **Give views a socket or token to HCP.** The token drives `agent.send`, `agent.read` (an
   agent's reply text), `spawn` and approvals. The sandbox's `connect-src 'none'` exists so that a
   view can't reach any of that. A read-only token is still a second protocol to secure, and it
   would put a privileged surface one bug away from every installed view.
2. **Stream raw or "redacted" output.** Redaction of terminal output can't be made reliable:
   secrets have no fixed shape, and ANSI redraws split them. Every use case in §3 needs *how much*
   and *when*, never *what*. A rate answers that and a transcript never becomes view data.
3. **A generic "call any ctl method" command.** It would grow the view surface every time `hive ctl`
   grows, so each future verb would reach views without a design review. It would also expose
   verbs that return content (`agent.read`, `stream`). Each addition here is named, typed and
   argued on its own.
4. **Keep views mounted while hidden so they can record history themselves.** It breaks "a view
   that is not active does zero work", multiplies the cost by the number of installed views, and
   each view would keep its own slightly different record. One host ledger is cheaper and gives
   every view the same record.
5. **Bump `PROTOCOL_VERSION` to 2.** The host requires `ready.v` to match exactly and refuses
   newer manifests, so every 1.3 view would be dead on every older app, and every older view
   would need a rebuild. Nothing in 1.3 breaks the wire.
6. **A permission per read-only feature** (`read:activity`, `read:history`, …). Old hosts refuse
   unknown permission names at install and load, so the view becomes uninstallable there. Each
   new line in the install review also teaches users to accept lines without reading them, and
   these facts are no more sensitive than `status`.
7. **Exact bytes/s for activity.** It leaks output length and echo timing (§4.3), and no scene
   needs the precision.
8. **Share through `allow-downloads` or a blob URL.** Adding `allow-downloads` to the sandbox
   would let a view write files without asking. A clipboard permission would let it write to the
   clipboard at any time. A host modal per share is the only form in which the user sees what
   leaves.
9. **Timestamps derived in the view from `setLayout`.** That's today's workaround. It records only
   what was seen while mounted, and every view has to relearn the "since" caveat. The host already
   knows the answer.

## 9. Open questions for the maintainer

1. **Should presence go into the ledger? Decided 2026-09-23: daily totals only** (seconds
   active, idle and away per day), with no intervals. The cost is that history can't subtract
   away time from a particular wait. A view shows "while you were away" as a day total next to
   the waits instead, and only the live `presence` message can pause a clock as it happens.
2. **The presence thresholds (2 min idle, 10 min away):** fixed, or a setting? Valley's Patience
   setting scales its own tiers, so the host could stay fixed.
3. **Ledger retention of 30 days and its scope by `layoutKey`:** should frames that belong to other
   repositories in the same window appear in history, as they do in `structure`? The recommendation
   and this design say yes, because `layoutKey` scopes the workspace and not a repository.
4. **Remote `view.emit`:** should the per-machine endpoint allow it, with `from: { machine }`? It
   would let a remote CI box light up the view, but it opens a write path from another machine into
   the app. Recommendation: not until the M5 write half has trust levels.
5. **Inferred turns for hook-less agents:** is a working→idle bucket transition good enough to
   call a turn? It is in practice for the providers that stream a spinner. It could be wrong for
   one that goes quiet mid-turn. The alternative is to send no turn events for those providers and
   let the view use status.
6. **Should `done-unseen` (the host's "finished and you haven't looked") become an event or a
   status flag?** Valley's outbox and the Queue's "Just finished" both reimplement it. It is left
   out of 1.3 because "seen" is a canvas concept that doesn't yet mean anything in a view.
7. **§2.3: both fixes, or only the confirm?** The recommendation is both. If the maintainer would
   rather not add a permission, the confirm alone still closes the hole, and the install sentence
   for `workspace:spawn` must then say "and start agents with instructions it writes. You'll see
   each one first". Also: should **Edit…** in the confirm stay? It helps when a view's template is
   nearly right, but it makes the dialog heavier.
8. **Model per tile** (Valley Phase 3, a robot body per model). `agent` already gives the provider.
   The model would have to come from the provider's session data, which isn't read today. It is
   out of scope here.
