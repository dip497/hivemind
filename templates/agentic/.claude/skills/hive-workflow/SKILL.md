---
name: hive-workflow
description: Use when you (an agent running in a hivemind tile) need to run a MULTI-AGENT workflow — fan a task out to several worker agents in parallel, chain agents into a pipeline, map-reduce over a list, or otherwise orchestrate a fleet of sibling agents on the canvas. Triggers on "fan out", "run N agents", "in parallel", "orchestrate", "spawn workers", "split this across agents", "review all these files", "map-reduce", or when an issue is too big for one agent and naturally decomposes into independent units. Prefer the `mcp__hive__hive_workflow` tool for fixed shapes; drop to raw spawn/read/connect only for dynamic control flow.
---

# Multi-agent workflows on the hivemind canvas

You are an agent in a hivemind tile. You can spawn **sibling agents as visible
tiles** and orchestrate them. Workers are real tiles the user watches — children
of you, depth-capped (max 3 deep) and rate-limited. Two layers:

1. **`mcp__hive__hive_workflow`** — one blocking call for the common shapes. Use
   this first. It spawns the fleet, drives it, and returns aggregated replies.
2. **Raw `mcp__hive__*`** (`hive_spawn_agent` / `hive_read` / `hive_connect` /
   `hive_report`) — when control flow is dynamic and no fixed shape fits.

> All of these no-op with "app not running" if hivemind isn't up — safe to try.

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

- `agent` — runtime for workers (`claude` default, `codex`, `droid`, …).
- `frame` — which frame to spawn into (omit = your frame; discover via `hive_list_frames`).
- `supervise` — broker workers' tool-permission prompts to YOU (answer with
  `hive_approve`) for unattended runs. `true` = mutating tools; `"all"` = everything.
- `max_concurrent` — live workers at once (default 6, cap 12).
- `timeout_ms` — per-worker turn ceiling (default 600000).
- `close_when_done` — tidy worker tiles after gathering (default false: leave them
  on the canvas to inspect).

### Reading the result

Each worker result has `status`: `turn` (got a reply, `text` is set), `timeout`
(still working past `timeout_ms`, `text` null), or `error` (spawn failed, `text`
is the reason). Always check `status` before trusting `text`.

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
