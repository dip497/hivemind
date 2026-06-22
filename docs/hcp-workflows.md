# HCP Workflows — multi-agent orchestration, hivemind-native

> Status: design. Target: a `hive_workflow` MCP tool + a `hive-workflow` skill that
> let an agent run multi-agent workflows on the canvas, using hive's own control
> plane instead of Claude Code's built-in `Workflow` tool.

## Goal

Claude Code ships a `Workflow` tool: a JS script with `agent()` / `parallel()` /
`pipeline()` / `phase()` that fans out **invisible** subagents and collects
structured results. We want the same developer experience, but:

- workers are **visible canvas tiles** (spawned via `hive_spawn_agent`), so the
  user watches every agent and can intervene;
- the orchestrator is itself a hive tile agent, invoked from `hive-work`;
- it runs on **HCP** (the existing 0600 unix-socket control plane), reusing the
  primitives already shipped in 1.6.0 — no new transport, no new hook.

## What already exists (and what's missing)

Shipped in HCP (`apps/desktop/src/main/hcp/methods.ts`):

| Primitive | Verb / mechanism |
|---|---|
| spawn a visible worker tile | `tile.spawn_agent` (depth-capped at 3, rate-limited) |
| deterministic turn await | `TurnTracker.waitForTurn(pid, afterSeq, timeoutMs)` — wakes on the Stop hook, reads the clean transcript reply (never screen-scrape) |
| auto-report child→parent | `connect(child, parent)` pipe on spawn (`report:true`) |
| chain workers | `tile.connect` / pipes |
| blocking read | `agent.read` |
| supervised tool approvals | `agent.await_approval` / `agent.approve` |
| spatial status | `pushWait(tile, status)` → status bus |

**Missing: the orchestration loop itself.** Today the orchestrating agent must
hand-roll spawn→read→gather across many tool calls in its own reasoning loop.
There is no single primitive that says "fan this list out to N tiles, await all,
return the results." That loop is the whole of this design.

## Design: hybrid (tool + skill)

Two layers, same engine:

1. **`hive_workflow` MCP tool** — the ergonomic 80%. Wraps the common shapes
   (`fanout`, `pipeline`, `mapreduce`) as one blocking call. The agent calls it
   once; HCP spawns the tiles, drives them, and returns an aggregated result.
2. **`hive-workflow` skill** — the escape hatch 20%. Teaches the orchestrator to
   compose arbitrary control flow (loop-until-dry, judge panels, conditional
   fan-out) directly from the existing `mcp__hive__*` tools, when a fixed shape
   doesn't fit.

The tool is convenience over the skill's primitives — anything the tool does, the
skill can do by hand. Both produce identical canvas behavior (visible tiles).

### Where the loop runs: HCP main

The orchestration loop lives in `methods.ts` as a new verb `workflow.run`,
because that's where every primitive it needs already lives: `depthOf`,
`spawnAllowed`, `TurnTracker`, `parentOf`, pipes, `pushWait`. The MCP tool
`hive_workflow` forwards to it exactly like every other canvas tool forwards
through `hcpCall`. The orchestrator agent's tool call blocks until the workflow
returns (same model as `agent.read` / `review.open` — long server-side ceiling).

```
orchestrator tile ── hive_workflow ──▶ MCP server ── hcpCall("workflow.run") ──▶ HCP main
                                                                                     │
                                              spawn N tiles (callerTile = orchestrator)
                                              waitForTurn on each (Promise.all, timeout)
                                              read transcripts, optionally reduce/close
   ◀──────────────── aggregated { items:[{item,tileId,text}], reduced? } ───────────┘
```

Every spawned tile sets `callerTile = orchestrator`, so depth-cap, auto-report
edges, and frame inheritance all work unchanged. Concurrency is bounded by a new
`maxConcurrent` (default ~6) on top of the existing per-minute rate gate; the
depth cap (3) still bounds recursion.

## `hive_workflow` tool surface

> JSON over MCP — **no function args.** Claude's `Workflow` passes `f => ...`;
> we can't. Per-item prompts use a **template string** with a `{item}` placeholder.
> Genuinely dynamic per-item prompts fall to the skill path.

```jsonc
{
  "name": "hive_workflow",
  "inputSchema": {
    "shape":        "fanout | pipeline | mapreduce",
    "items":        ["string", ...],        // fanout/mapreduce: one worker per item
    "prompt":       "review {item} for bugs",// {item} substituted per worker
    "stages":       ["string", ...],         // pipeline: prompt per stage, chained
    "agent":        "claude",                // runtime per worker (claude/codex/droid/…)
    "frame":        "manageark",             // omit → orchestrator's own frame
    "supervise":    true,                    // broker workers' tool perms to orchestrator
    "max_concurrent": 6,
    "timeout_ms":   600000,                  // per-worker turn ceiling
    "reduce_prompt":"synthesize: {results}", // mapreduce: reducer agent over all results
    "close_when_done": true                  // tidy worker tiles after gather (default false)
  }
}
```

Returns:

```jsonc
{
  "shape": "fanout",
  "items": [
    { "item": "auth.ts",  "tileId": "tile_a1", "status": "turn",    "text": "..." },
    { "item": "pay.ts",   "tileId": "tile_b2", "status": "timeout", "text": null  }
  ],
  "reduced": "…reducer output…"   // only for mapreduce
}
```

### Shapes

- **`fanout`** — spawn one tile per `items[i]` with `prompt` (`{item}` filled),
  `waitForTurn` on all (capped concurrency), return each transcript. = Claude's
  `parallel(items.map(...))`.
- **`pipeline`** — spawn stage-1, deliver `stages[0]`, await turn, feed its reply
  as the input to stage-2's prompt, … Implemented by `connect()`-ing the chain
  and awaiting the terminal tile, or by sequential `send`+`waitForTurn`. = Claude's
  `pipeline(item, ...stages)` for a single item; loop the tool per item for the full pipeline.
- **`mapreduce`** — `fanout`, then spawn one reducer tile fed all worker
  transcripts via `reduce_prompt` (`{results}` = joined outputs), return its reply.

Arbitrary shapes (loop-until-dry, judge panels, tournament) → skill.

## `hive-workflow` skill (the escape hatch)

A new skill at `templates/agentic/.claude/skills/hive-workflow/SKILL.md`, sibling
to `hive-work`. Triggers on "orchestrate", "fan out", "run N agents in parallel",
"multi-agent", "spawn workers", or when a hive issue is too big for one agent.
It teaches the patterns Claude's `Workflow` doc describes, re-expressed in hive tools:

- **Fan-out / gather** — `hive_spawn_agent({prompt, report:true})` × N (fire-and-forget;
  replies auto-land in your terminal as `[hive] report from <tile>`), keep working,
  collect. Or `hive_workflow({shape:"fanout"})` for the blocking version.
- **Pipeline** — `hive_connect(a,b)`, `hive_connect(b,c)`; seed `a`; the chain flows.
- **Map-reduce** — fan out, then spawn a reducer and `hive_send` it the gathered results.
- **Loop-until-dry** — spawn a finder, read its output, re-spawn until two empty rounds.
- **Judge panel** — fan out N solvers, fan out M judges over each, keep majority.
- **Supervised unattended run** — spawn with `supervise:true`; approve via `hive_approve`.

The skill's north star: **prefer `hive_workflow` for fixed shapes; drop to raw
`mcp__hive__*` only when control flow is dynamic.**

## Durability via the issue board (hivemind's native resume)

Claude's `Workflow` has a `runId` journal for resume. Hivemind already has durable
state: `.hivemind/issues/`. The native resume story is to **back a workflow with
sub-issues** — optional `track: true` on `hive_workflow`:

1. create a parent issue for the run + one sub-issue per item (`hive_create_issue`);
2. each worker claims its sub-issue (`in_progress`) and sets `in_review`/`done` on finish;
3. if the app restarts mid-run, the board shows exactly which items are unfinished —
   re-running the workflow skips `done` sub-issues.

This is strictly better than an in-memory journal: it survives restarts, is visible
on the canvas/board, and is queryable by other agents. v1 can ship without it
(in-memory only) and add `track` in a later phase.

## Phases

1. **`workflow.run` in HCP main** — `fanout` only. Spawn loop + `Promise.all`
   over `waitForTurn` with a concurrency cap; transcript read per worker; return
   aggregate. (`methods.ts`, `MethodDeps` already exposes everything needed.)
2. **`hive_workflow` MCP tool** — schema + `hcpCall("workflow.run")` forward in
   `packages/hive-mcp/src/index.ts` (add to `CANVAS_TOOLS`); mirror as
   `hive ctl workflow` in `apps/cli/src/commands/ctl.ts`.
3. **`pipeline` + `mapreduce` shapes** — chained `connect`/`send` + reducer spawn.
4. **`hive-workflow` skill** — `templates/agentic/.claude/skills/hive-workflow/`,
   wired into `agentic-install.ts` (`installHiveSkill` → install both skills);
   document the tool in `templates/agentic/CLAUDE.md` under a "Multi-agent workflows" section.
5. **`track: true`** — issue-board-backed durable runs + resume.
6. **(later) structured output** — convention: workers end with a fenced `json`
   block; runtime extracts it → typed results, à la Claude's `schema` option.

## Files this touches

| File | Change |
|---|---|
| `apps/desktop/src/main/hcp/methods.ts` | new `workflow.run` verb + concurrency cap |
| `apps/desktop/src/main/hcp/protocol.ts` | (none — reuses req/res) |
| `packages/hive-mcp/src/index.ts` | `hive_workflow` tool def + handler + `CANVAS_TOOLS` |
| `apps/cli/src/commands/ctl.ts` | `hive ctl workflow` subcommand |
| `templates/agentic/.claude/skills/hive-workflow/SKILL.md` | new skill |
| `apps/cli/src/agentic-install.ts` | install the new skill alongside `hive-work` |
| `templates/agentic/CLAUDE.md` | document multi-agent workflows |
| `CHANGELOG.md` | `[Unreleased]` entry (minor — new MCP tool) |

## Non-goals (v1)

- Arbitrary JS scripts à la Claude's `Workflow` engine — the skill covers dynamic
  control flow; we don't ship a JS interpreter in HCP.
- Cross-frame / cross-repo fan-out in one call — workers spawn into one frame; use
  the issue board's cross-repo links for that.
- Budget/token accounting — out of scope until there's a token meter in HCP.
