# Plan Review & Annotation — Architecture

Native, in-canvas plan/diff review for hivemind agents. Devours plannotator's
methodology and surpasses it by living *inside* the canvas (no detached browser,
no manual per-agent config) and feeding into systems plannotator lacks (the issue
tracker, the diff tile, remote frames).

## What plannotator does (verified end-to-end via deepwiki)

- **Intercept**: Claude Code hook on the plan handoff → spawns a binary → reads
  the plan markdown from stdin (`tool_input.plan`) → serves a React SPA in a
  **browser** → blocks → returns approve/deny+feedback over stdout.
- **Annotate**: markdown parsed to `Block`s; user drag-selects text or
  pinpoint-clicks a block → `DELETION` / `COMMENT` / `GLOBAL_COMMENT` /
  quick-label (web-highlighter for cross-element ranges).
- **Feedback**: `exportAnnotations()` formats annotations → markdown string →
  `wrapFeedbackForAgent()` → returned as the deny message; agent revises.
- **Plus**: plan diff between versions, code review on git diffs, annotate any
  file, zero-knowledge share, archive/history/drafts under `~/.plannotator/`.

Its ceiling: a separate web app bolted on through N per-agent plugins; approved
plans dead-end into an Obsidian file.

## The exact Claude Code contract (verified against current docs)

- Hook event: **`PreToolUse`**, `"matcher": "ExitPlanMode"`.
- settings.json shape:
  ```json
  { "hooks": { "PreToolUse": [ { "matcher": "ExitPlanMode",
      "hooks": [ { "type": "command", "command": "<cmd>", "timeout": 345600 } ] } ] } }
  ```
  `timeout` is in **seconds**.
- Hook **stdin** (JSON): `{ session_id, cwd, hook_event_name:"PreToolUse",
  tool_name:"ExitPlanMode", tool_input: { plan: "<markdown>" } }`.
- Hook **stdout** (exit 0):
  - approve → `{ "hookSpecificOutput": { "hookEventName":"PreToolUse",
    "permissionDecision":"allow" } }`
  - request changes → `{ "hookSpecificOutput": { "hookEventName":"PreToolUse",
    "permissionDecision":"deny", "permissionDecisionReason":"<feedback markdown>" } }`
  On deny, `permissionDecisionReason` is fed back to the model — that's the
  feedback channel. The agent stays in plan mode and revises.

## How hivemind surpasses it

| Pillar | plannotator | hivemind |
|---|---|---|
| Intercept | manual settings.json, per-agent plugin | **auto-injected** at spawn via the `--settings` we already inject (`claude-resume.ts`) — zero user config |
| Surface | detached browser tab | **canvas tile** beside the agent, spatial, multiple open |
| Annotate code | own diff viewer | **reuse DiffTile** (`@pierre/diffs`, already line-level select+comments) |
| Approved plan | → Obsidian file | → **issue tree** (rich create w/ acceptance criteria + sub-issues); annotations → AC items / comments |
| Agents | N plugins | **one surface**; our spawn layer unifies claude/codex/opencode |

## The round-trip (spine)

```
claude (in a PTY tile) calls ExitPlanMode
  → injected PreToolUse hook script (added to the --settings hivemind already injects)
  → reads tool_input.plan from stdin; HIVEMIND_TILE env tells it which tile
  → connects to the plan-bridge unix socket (owned by Electron main)
  → sends {tileId, plan, cwd}; BLOCKS holding the connection
  → main makes it a plan wait (`packages/host/src/waits.ts`): the agent's status says it waits on
    a plan, and the agent list carries it (`waiting.plan`, named by the wait's `since`)
  → every window showing the agent opens a PlanReviewTile beside it, on every machine the
    workspace is shared with
  → someone who may drive agents annotates + clicks Approve / Request changes
  → `agent.answer(tile, since, {decision, feedback?})`: the first answer is written back over the
    held socket; a later one hears who answered first; everyone hears `answered`, with who
  → hook prints the stdout JSON, exit 0 → claude proceeds / revises
```

`hive ctl open-review` makes the same plan wait for the agent in its tile (`review.open`).

Fail-open: if the bridge is unreachable (app closed, socket gone), the hook
prints `allow` so a missing review UI never bricks the agent.

## Where each piece lives

- `main/plan-bridge.ts` — `net.createServer` over a unix socket (`<userData>/plan-bridge.sock`,
  mode 0600). NDJSON. Holds each hook connection until its plan wait is answered; a dropped
  connection ends the wait unanswered.
- `packages/host/src/waits.ts` — the waits a person answers: plans, and supervised tool uses.
- `packages/host/src/answers.ts` — `agent.answer`, for every wait the agent list shows.
- `main/claude-resume.ts` — injects the `PreToolUse` hook alongside the `SessionStart` hook.
- renderer: `tiles/plan-review.tsx` (the `planReview` tile kind), `PlanReviewTile.tsx`, and the
  effect in `Workspace.tsx` that opens and closes reviews from the agent list.

## Phases (each shippable)

1. **Spine** — bridge + injected hook + `planReview` tile + minimal approve/deny
   round-trip. Riskiest; proves the whole mechanism.
2. **Annotation engine** — `marked.lexer()` → blocks; pinpoint + text-range;
   delete/comment/global/quick-label; `exportAnnotations` feedback formatter.
3. **Plan → issue** — on approve, optional "materialize as issue tree";
   annotations → acceptance-criteria / comments.
4. **Code review** — annotate the DiffTile; package comments → feedback → agent.
5. **Plan diff + history + drafts**; then codex/opencode hook parity.

## Security note

The bridge is a unix socket, mode 0600, under `userData` — only the user's own
processes can connect (same posture as the existing pty-daemon socket). The hook
command is assembled with `shq()` quoting (already used for the tracker). The
plan content is rendered through `MarkdownPreview` (DOMPurify-sanitized). No
network surface is added.
