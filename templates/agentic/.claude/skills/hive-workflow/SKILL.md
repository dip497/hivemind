---
name: hive-workflow
description: Use when you (an agent running in a hivemind tile) need to run a MULTI-AGENT workflow — fan a task out to several worker agents in parallel, chain agents into a pipeline, map-reduce over a list, or otherwise orchestrate a fleet of sibling agents on the canvas. Triggers on "fan out", "run N agents", "in parallel", "orchestrate", "spawn workers", "supervise", "approve", "split this across agents", "review all these files", "map-reduce", "delegate", "spawn a pi/codex/droid agent", or when an issue is too big for one agent and naturally decomposes into independent units. Also covers driving a spawned worker: follow-up turns (hive_send), answering its picker (hive_send_keys), gatekeeping its tools (supervise + hive_approve), and polling fleet status (hive_list_tiles). Prefer the `mcp__hive__hive_workflow` tool for fixed shapes; drop to raw spawn/send/read/connect only for dynamic control flow.
---

# Multi-agent workflows on the hivemind canvas

You are an agent in a hivemind tile. You can spawn **sibling agents as visible
tiles** and orchestrate them. Workers are real tiles the user watches — children
of you, depth-capped (max 3 deep) and rate-limited. Two layers:

1. **`mcp__hive__hive_workflow`** — one blocking call for the common shapes. Use
   this first. It spawns the fleet, drives it, and returns aggregated replies.
2. **Raw `mcp__hive__*`** (`hive_spawn_agent` / `hive_send` / `hive_send_keys` /
   `hive_read` / `hive_connect` / `hive_approve` / `hive_list_tiles` /
   `hive_report`) — when control flow is dynamic and no fixed shape fits.

> All of these no-op with "app not running" if hivemind isn't up — safe to try.

**Auto-report is the default.** A spawned worker (and every `hive_workflow`
worker) delivers its reply straight into YOUR session when it finishes a turn —
you see a `[hive] from <tileId>: …` message. So the normal pattern is
fire-and-forget: spawn, keep working, collect the reports as they arrive. Only
reach for `hive_read` when you must BLOCK inline for the next reply. To check who
is still busy without blocking, poll `hive_list_tiles`.

## When to use which

| You need… | Use |
|---|---|
| Same task over a list, in parallel | `hive_workflow({ shape: "fanout" })` |
| Fan out + synthesize the results | `hive_workflow({ shape: "mapreduce" })` |
| A → B → C, each consuming the last | `hive_workflow({ shape: "pipeline" })` |
| Loop until a condition / unknown count | raw spawn + `hive_read` loop |
| A judge panel, voting, conditional branches | raw spawn + `hive_read` |

## The tool: `hive_workflow`

### fanout — N workers in parallel

One worker per `items[i]`. `prompt` is a template; `{item}` is filled per worker.
Blocks until all finish, returns each reply.

```
hive_workflow({
  shape: "fanout",
  items: ["src/auth.ts", "src/pay.ts", "src/api.ts"],
  prompt: "Review {item} for security bugs. List findings as file:line — one line each.",
  max_concurrent: 6
})
// → { shape:"fanout", items:[ {item, tileId, status:"turn"|"timeout"|"error", text}, … ] }
```

### mapreduce — fanout, then one reducer

Runs the fanout, then spawns ONE reducer agent fed every worker's output via
`reduce_prompt` (`{results}` = all outputs joined).

```
hive_workflow({
  shape: "mapreduce",
  items: ["auth", "billing", "search"],
  prompt: "Summarize the {item} module in 3 bullets.",
  reduce_prompt: "Here are module summaries:\n{results}\n\nWrite a one-paragraph architecture overview."
})
// → { shape:"mapreduce", items:[…], reduced:"…overview…" }
```

### pipeline — a sequential chain

`stages` is an array of prompts run in order. Each stage may reference `{input}`
(the prior stage's reply). `input` optionally seeds the first stage.

```
hive_workflow({
  shape: "pipeline",
  stages: [
    "Draft a migration plan for moving sessions to Redis.",
    "Critique this plan, list the top 3 risks:\n{input}",
    "Rewrite the plan addressing those risks:\n{input}"
  ]
})
// → { shape:"pipeline", steps:[…], output:"…final…" }
```

### Common options

- `agent` — runtime for every worker: `"claude"` (default), `"codex"`, `"droid"`,
  `"opencode"`, or **`"pi"`**. `pi` is a first-class runtime — turn-detection,
  reply, supervise, and even the orchestration tools all work with `agent:"pi"`
  exactly like claude. Non-claude runtimes must be installed on the host or the
  worker comes back `status:"error"`.
- `model` — claude only: `"opus"` | `"sonnet"`, applied to every worker. Omit for
  the workspace default. (Ignored by non-claude runtimes.)
- `frame` — which frame to spawn into (omit = your frame; discover via `hive_list_frames`).
- `supervise` — broker workers' tool-permission prompts to YOU (answer with
  `hive_approve`) for unattended runs. `true` (or `"parent"`) = the mutating tools
  (Bash/Edit/Write/WebFetch); `"all"` = every tool; or a comma-string / array of
  tool names to broker a specific set. See "Supervising a fleet" below.
- `max_concurrent` — live workers at once (default 6, cap 12).
- `timeout_ms` — per-worker turn ceiling (default 600000).
- `close_when_done` — tidy worker tiles after gathering (default false: leave them
  on the canvas to inspect).

### Reading the result

Each worker result has `status`: `turn` (got a reply, `text` is set), `timeout`
(still working past `timeout_ms`, `text` null), or `error` (spawn failed, `text`
is the reason). Always check `status` before trusting `text`.

## Spawning & driving a single worker

`hive_workflow` is the fleet API; underneath it are the per-worker primitives you
use for dynamic control flow.

- **Spawn** — `hive_spawn_agent({ prompt, agent?, frame?, model?, mode?, report?, supervise? })`
  → `{ tileId }`. `report` defaults `true` (auto-delivers the reply to you); set
  `false` only for a fire-and-forget worker you'll poll with `hive_read`. With no
  `mode`, a delegated worker runs AUTONOMOUSLY (bypass permissions) since no human
  is at its tile — pass `mode: "plan"|"acceptEdits"|"default"` to keep a human in
  the loop, or `supervise` to route its prompts to you.
- **Follow-up turn** — `hive_send({ tileId, text, submit? })` continues the
  conversation (like typing into its terminal and pressing Enter; `submit` defaults
  `true`). Use it to give a worker its next instruction after reading its reply.
- **Blocking read** — `hive_read({ tileId, timeout_ms? })` blocks until the worker
  finishes its current turn, then returns `{ text, finalStatus: "turn" | "timeout" }`.
  `text` is the worker's final assistant message, read cleanly from the session
  transcript (never screen-scraped). On timeout (`timeout_ms` default 120000) it
  returns `finalStatus:"timeout"` with the worker STILL working — not raw output.
  Because `report:true` already auto-delivers replies, use `hive_read` ONLY when
  you must block inline for the answer.
- **Drive its TUI** — `hive_send_keys({ tileId, keys: [...] })` sends raw key
  tokens when plain text won't do. The key case: a spawned worker that calls its
  native **AskUserQuestion** popup blocks on that picker with no human at its tile
  to answer. YOU answer it: e.g. to choose the 2nd option,
  `hive_send_keys({ tileId, keys: ["Down", "Enter"] })`. Tokens: `Up`/`Down`/
  `Left`/`Right`, `Enter`, `Esc`, `Tab`, `Space`, `Backspace`, `Home`/`End`/
  `PageUp`/`PageDown`, or any literal text/digits (sent as-is).
- **Status / housekeeping** — `hive_list_tiles({ frame? })` returns tiles grouped
  by frame, each agent tile carrying a live `status` (working / idle / blocked /
  awaiting_approval / question / …) — poll it to see who's busy or stuck.
  `hive_focus({ tileId })` brings a tile into view; `hive_close_tile({ tileId })`
  shuts a worker down.

## Supervising a fleet (unattended runs)

Spawn (or `hive_workflow`) with `supervise` and YOU become the gatekeeper for the
workers' tool-permission prompts instead of a human. When a supervised worker hits
a brokered tool, you receive a message:

```
[hive] APPROVAL — worker <id> wants to run <tool>: <summary>
Reply: hive_approve("<reqId>", …)
```

Answer it with:

```
hive_approve({ reqId: "<reqId>", decision: "allow" | "deny" | "always" | "never", reason? })
```

- `allow` / `deny` — decide THIS one call.
- `always` / `never` — decide it AND remember the decision for that worker+tool, so
  you won't be prompted for it again.
- `reason` — optional note shown to the worker (useful on `deny`, so it can adapt).

This lets you run a whole fan-out unattended with yourself as the single approval
authority. It fails safe: if you never answer, the prompt falls back to the human.
Poll `hive_list_tiles` to spot workers stuck in `awaiting_approval`.

## Human sign-off mid-run: `hive_open_review`

`hive_open_review({ plan, cwd? })` opens the plan in hivemind's visual review tile
and BLOCKS until the human approves or requests changes, returning
`{ decision: "allow" | "deny", feedback? }`. Use it to get a human to sign off on a
plan you generated (e.g. before a destructive fan-out) — the one place you loop a
human back in during otherwise-autonomous orchestration.

## Raw orchestration (the escape hatch)

When a fixed shape won't express the control flow, drive the primitives yourself.

### Fan-out, fire-and-forget (don't block)

Spawn with `report:true` (the default) and keep working — each worker's reply
auto-lands in YOUR session as `[hive] report from <tileId>: …` when it finishes.

```
for f in files: hive_spawn_agent({ prompt: `Review ${f}`, })   // report defaults true
// keep doing other work; collect the [hive] reports as they arrive
```

### Loop-until-dry (unknown count)

```
spawn a finder → hive_read(tileId) → if it found nothing twice in a row, stop;
else spawn another round seeded with what's been found so far.
```

### Judge panel

```
fanout N solvers over the SAME problem (items = ["a","b","c"] as variant labels) →
for each solution, fanout M judges → keep the majority verdict.
```

### Pipeline by hand

```
const a = hive_spawn_agent({ prompt: "stage 1 …" })
const b = hive_spawn_agent({ prompt: "you receive input from upstream; do stage 2" })
hive_connect(a.tileId, b.tileId)   // a's replies flow into b automatically
// hive_disconnect(a.tileId, b.tileId) to remove the pipe (omit dst to clear all from a)
```

## Durability (optional)

For long fan-outs you want to survive an app restart, back the run with the issue
board: `hive_create_issue` a parent + one sub-issue per item, have each worker set
its sub-issue `in_progress` → `done`. The board then shows exactly which items are
unfinished, and a re-run skips the `done` ones. This is hivemind's native resume —
durable, visible, and queryable by other agents.

## Guardrails

- **Workers are visible.** The user watches every tile spawn and run. Don't fan
  out dozens silently — scale to the task, and say what you're launching.
- **Depth is capped at 3.** A worker you spawn can spawn its own workers, but only
  so deep — design shallow fan-outs, not deep recursion.
- **Prefer `hive_workflow` over hand-rolling** for the three fixed shapes — it
  handles concurrency limits, retries through the rate gate, and clean transcript
  reads for you. Reach for raw primitives only when the shape is dynamic.
