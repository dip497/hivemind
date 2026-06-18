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
  → sends {requestId, tileId, plan, cwd}; BLOCKS holding the connection
  → main pushes "plan-review:open" → renderer opens a PlanReviewTile in the
    agent's frame, pre-loaded with the plan
  → user annotates blocks + clicks Approve / Request changes
  → renderer → main ("plan-review:decide") → main writes {decision, feedback}
    back over the held socket
  → hook prints the stdout JSON, exit 0 → claude proceeds / revises
```

Fail-open: if the bridge is unreachable (app closed, socket gone), the hook
prints `allow` so a missing review UI never bricks the agent.

## Where each piece lives (grounded in real files)

**main process**
- `main/plan-bridge.ts` (new) — `net.createServer` over a unix socket
  (`<userData>/plan-bridge.sock`, mode 0600 — same trust model as the existing
  daemon socket). NDJSON. Holds each hook connection until `reply()`; registry
  keyed by `requestId`.
- `main/plan-review-hook-source.ts` (new) — `planHookSource()` returns a
  self-contained CJS string (no deps). Reads stdin, connects to the socket,
  blocks, prints the decision JSON. Fail-open on any error.
- `main/index.ts` — on ready: bind the bridge; `onRequest` →
  `webContents.send("plan-review:open", …)` + stash `reply` in a Map;
  `ipcMain.handle("plan-review:decide", …)` resolves it.

**daemon** (`main/pty-daemon.ts`) — writes `plan-review-hook.cjs` next to the
tracker; passes `planHookPath` + `planBridgeSock` (derived from `userDataDir`,
which it already derives at line 42) into `makeClaudeResumeTransforms`.

**injection** (`main/claude-resume.ts`) — `ClaudeResumeDeps` gains
`planHookPath` + `planBridgeSock`; `trackerSettings()` adds the `PreToolUse`
hook alongside the existing `SessionStart` hook. Daemon-mode only for v1 (same
as resume tracking — `makeClaudeResumeTransforms` only runs in the daemon).

**renderer**
- `tile-kinds.ts` — add `"planReview"`.
- `canvas-persistence.ts` — `TileInstance.review?: {requestId, plan, cwd}`;
  exclude `planReview` tiles from the saved layout (ephemeral — tied to a live
  blocked hook).
- `PlanReviewTile.tsx` (new) — Phase 1: render plan via `MarkdownPreview`,
  Approve + Request-changes (textarea). Phase 2: the annotation engine.
- `canvas-nodes.tsx` — `PlanReviewNode` wrapper + register in `nodeTypes`.
- `canvas-node-build.ts` — emit the node for kind `planReview`.
- `Canvas.tsx` — subscribe to `plan-review:open`; spawn the tile in the agent
  tile's frame; on decide call the IPC + close the tile.
- `preload/index.ts` — `onPlanReviewOpen(cb)` + `planReviewDecide(...)`.
- `shared/ipc.ts` — types for the above.

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
