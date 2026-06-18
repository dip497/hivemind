# HCP Phase 6 — Agent-Supervised Approvals

> When a spawned worker hits a tool-permission prompt, it **escalates to the agent
> that spawned it** instead of stopping for a human. The supervisor approves /
> denies / answers programmatically and the worker resumes. A human stays in the
> loop only at the root of the tree (and as the always-available fail-safe).

## Why this is sound (prior art)

Researched against current docs (2026-06):

- **Claude Code `PreToolUse` hook is a real permission broker.** It returns
  `hookSpecificOutput.permissionDecision: "allow" | "deny" | "ask"` (+
  `permissionDecisionReason`). `"allow"` **suppresses the interactive prompt
  entirely** — the tool just runs; `"deny"` cancels and feeds the reason back to
  the model; `"ask"` shows the normal prompt. The hook receives
  `{session_id, cwd, tool_name, tool_input, permission_mode}` on stdin, may
  **block** (network/socket) while deciding, has a ~10-minute timeout, and on
  timeout / empty output **falls through to the normal permission flow**
  (fail-safe). We ALREADY ship this exact round-trip for one tool —
  `PreToolUse(ExitPlanMode)` → plan-review tile. This phase generalizes it.
- **Agent SDK `canUseTool(toolName, input) → allow|deny|defer`** is a cleaner
  async callback but requires running the worker via the SDK, not as an
  interactive PTY tile. Our workers are visible, user-attachable tiles, so the
  hook path fits; an SDK-backed headless worker is a possible future runtime.
- **LangGraph** `interrupt()` / `interrupt_on` (per-subagent) is the mature
  supervisor-approves-worker pattern — validates the shape.
- **MCP elicitation/sampling** is NOT the right primitive — elicitation is
  one-way (server→client UI), not agent↔agent. Don't use it here.
- **Codex / CrewAI / OpenAI Agents SDK**: no programmatic remote-approval hook
  (terminal-only). Claude Code's hook is the most explicit pre-execution gate.

## Architecture

Generalize the plan-review broker. Reuse the same seam: an injected hook blocks
on the HCP socket; main brokers the decision; a held connection resolves it.

```
worker PreToolUse hook ──{tool_name,tool_input,tileId,reqId}──▶ HCP (main)
                                                                  │
                              remember-cache hit? ──yes──▶ allow/deny (no round-trip)
                                                                  │ no
                                                deliver to PARENT inbox:
                                   "[hive] worker X wants Bash(\"pnpm build\") — approve?"
                                                                  │
parent agent ── hive_approve(reqId, allow|deny|always|never, reason?) ──▶ HCP
                                                                  │
        hook unblocks → prints {permissionDecision, reason} exit 0 → worker resumes
```

### Flow

1. Spawn with a supervise policy: `hive_spawn_agent({…, supervise: "parent"})`
   (or `supervise: ["Bash","Write"]` for a tool allowlist).
2. `claude-resume` injects a `PreToolUse` hook whose matcher = the brokered tool
   set, into the worker's `--settings` (same mechanism as the existing hooks).
3. On a matched tool call the hook reads stdin, connects to the HCP socket, sends
   `{t:"approval", tileId, reqId, tool_name, tool_input}` and **blocks**.
4. HCP main:
   - **remember-cache**: if `(worker, tool)` was previously `always`/`never`,
     respond immediately (no parent round-trip). This is what makes it usable —
     otherwise every Bash call pesters the parent.
   - else deliver a concise prompt to the **parent's inbox** (PTY write, the
     mailbox we already use for auto-report) and hold the hook connection in a
     `pendingApprovals` map (twin of `planReplies` / `pendingHcp`).
5. Parent calls **`hive_approve(reqId, decision, reason?)`**,
   `decision ∈ {allow, deny, always, never}`:
   - `always` → cache allow for `(worker, tool)`; `never` → cache deny.
6. HCP resolves the held hook → it prints
   `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}}`
   and exits 0 → worker proceeds (or adapts to the deny reason).
7. **Fail-safe**: no parent, or no answer within a timeout (< the hook's 10-min
   ceiling) → the hook emits nothing / `permissionDecision:"ask"` → the normal
   human prompt appears in the worker's tile. NEVER a silent allow.

### Scoping (avoid round-trip storms)

- Default brokered set = **mutating / external** tools: `Bash`, `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`, `WebFetch`, MCP writes. **Auto-allow safe reads**
  (`Read`, `Glob`, `Grep`, `LS`) so the supervisor isn't pestered for harmless
  calls.
- `always` / `never` remember-cache per `(worker, tool)` — the supervisor
  approves "Bash for this worker" once, then it flows.

### Security

- **Opt-in** (`supervise`), bounded by the existing depth (≤3) + spawn-rate caps.
- It deliberately removes the *human* gate between agents — so the **top-level
  agent (nearest the human) is the ultimate supervisor**, and a human is always
  the tree root + the timeout fail-safe.
- Deny reasons flow back to the worker (it adapts, doesn't just halt).
- The approval socket message is token-less like the turn event → constrain it
  (the 0600 socket is the trust boundary; validate `tileId` is a known worker).

## Surface

- **MCP**: `hive_approve(reqId, decision, reason?)`; `supervise` arg on
  `hive_spawn_agent`. The pending approval also shows in `hive_list_tiles`
  (status `permission` + the requested tool) so a supervisor agent can poll.
- **CLI**: `hive ctl approve <reqId> allow|deny|always|never [reason]`.
- **Canvas**: the worker tile shows "needs approval: Bash(…)" and a dashed edge to
  its supervisor; clicking still lets a human decide in-tile (fail-safe path).

## Files (planned)

- New `apps/desktop/src/main/approval-hook-source.ts` — the PreToolUse broker hook
  (CJS string, mirrors `plan-review-hook-source.ts`).
- `claude-resume.ts` — inject the hook (matcher = brokered tools) when the spec
  carries a supervise policy; pass the brokered-tool list via env.
- `main/index.ts` — `pendingApprovals` map + socket `approval` handler +
  remember-cache + deliver-to-parent + resolve-on-`hive_approve`.
- `hcp/methods.ts` — `agent.approve` verb; record supervise policy at spawn.
- `packages/hive-mcp/src/index.ts` — `hive_approve` tool; `supervise` on spawn.
- `apps/cli/src/commands/ctl.ts` — `approve` subcommand.

## Explicitly out of scope (v1)

- SDK-backed headless workers using `canUseTool` (different runtime).
- Per-argument approval policies (e.g. allow `git` but not `rm`) — start with
  per-tool; a matcher predicate can come later.
- Cross-machine supervision (remote frames) — local socket only for now.
