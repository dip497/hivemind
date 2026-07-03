---
name: hive-work
description: Use whenever the user references a hivemind issue key (e.g. PAY-42, BUG-7, anything matching ^[A-Z]+-\\d+) or asks to update an issue's status, add a comment, mark acceptance criteria done, or complete work on an issue. Always use mcp__hive__* tools — do NOT use the Bash tool to invoke the hive CLI directly.
---

# Working a hivemind issue (Execution Contract)

**Always use the `mcp__hive__*` tools — never shell out to the `hive` CLI via
Bash.** The MCP tools keep the activity log, `updated` timestamp, and the board's
live view in sync; the CLI is for humans. Every tool below works cross-repo: an id
whose prefix belongs to another *registered* workspace resolves automatically.

When you start work on issue `$KEY`:

1. **Load context** — call `mcp__hive__hive_get_issue({ id: $KEY })`. Read the title, description, and `acceptanceCriteria` array.

2. **Claim it (REQUIRED, do this FIRST)** — in one move, take ownership:
   - `mcp__hive__hive_set_state({ id: $KEY, state: "in_progress" })` (skip only if already in_progress)
   - `mcp__hive__hive_update_issue({ id: $KEY, assignee: { type: "agent", id: "claude" } })` so the board shows WHO is on it.
   Status + assignee are owned by you (the agent) via these calls — the UI does
   not guess them. This is what makes the canvas/board reflect live agent activity.

3. **Branch (if the repo uses feature branches)** — isolate your work so parallel
   agents don't collide: `git switch -c $KEY` (or reuse an existing branch named
   for the issue). Skip if the repo works trunk-based or you're already on a
   suitable branch.

4. **Plan** — outline the steps to complete each criterion. Post the plan as a comment via `mcp__hive__hive_add_comment` (one paragraph, no preamble).

5. **Execute** — do the actual work using Edit / Write / Bash for code changes. After completing each criterion, call `mcp__hive__hive_mark_acceptance({ id: $KEY, index: N, done: true })`.

6. **Verify & commit (REQUIRED before review)** — run the repo's tests / typecheck / build (whatever it has) and make them pass. Then commit your work with the issue id in the message: `git commit -am "$KEY: <what changed>"`. **Do NOT push** unless the user explicitly asked — pushing is a human-authorised action. Committing locally is expected.

7. **Report progress** — when meaningful work is done, post a comment summarising what you did and pointing at the changes (file:line refs).

8. **Final disposition (REQUIRED)** — end EVERY work session with one of:
   - `mcp__hive__hive_set_state({ id: $KEY, state: "in_review" })` — work complete, awaiting human review
   - `mcp__hive__hive_set_state({ id: $KEY, state: "done" })` — only if you have explicit authority
   - `mcp__hive__hive_set_state({ id: $KEY, state: "blocked", note: "<why>" })` — cannot proceed; explain
   - `mcp__hive__hive_set_state({ id: $KEY, state: "in_progress" })` — still going; will resume next session

**Do not exit silently.** Failing to call `hive_set_state` leaves the issue in a stale state and breaks the team's view of what's happening.

## Handling review feedback

When a human leaves a review comment on your diff (it arrives as a prompt like
`Review comment on src/x.ts:42 (new): <text>`):

1. **Record it on the issue** — `mcp__hive__hive_add_comment({ id: $KEY, message: "review: <file:line> — <comment>" })` so the feedback is durable in the issue's activity log, not just in your terminal.
2. **Address it** — make the change, re-verify, and commit (`git commit -am "$KEY: address review on <file>"`).
3. If you'd marked it `in_review`, set it back to `in_progress` while you work, then `in_review` again when done.

## Sub-tasks

If the issue is too large, break it down via `mcp__hive__hive_create_issue({ title, parent: $KEY })`. New sub-issues inherit the parent's id (e.g. PAY-42.1). Put acceptance criteria in the `acceptance_criteria` string-array argument (NOT inside `description`) so they land in the tickable checklist. `hive_create_issue` also takes `labels` and an initial `state`.

## Cross-repo & linking

In a multi-repo setup, hive can reach issues in OTHER registered workspaces:

- `mcp__hive__hive_list_workspaces()` — list every registered workspace with its prefix, title, and repo path. Use it to discover where you can move or link.
- `mcp__hive__hive_list_issues({ workspace: "OPS", state?, label?, assignee? })` — pass a `workspace` prefix to list ANOTHER repo's issues; omit for the current one.
- `mcp__hive__hive_link_issue({ id, other_id, type })` — link two issues across (or within) repos. `type` ∈ `relates` (default) | `blocks` | `blocked-by` | `duplicates` | `parent-of` | `child-of`; the reciprocal is recorded automatically. For the single-repo parent hierarchy use `hive_update_issue({ parent })` instead.
- `mcp__hive__hive_move_issue({ id, to_workspace, mode })` — transfer an issue to another workspace by prefix. `mode: "move"` (default) deletes the source and stamps the new issue `moved-from`; `mode: "copy"` keeps the source and links both with `relates`. Refuses issues that have sub-issues.

## Full issue toolset

| Tool | Purpose |
|---|---|
| `hive_get_issue({ id })` | Load one issue (title, description, `acceptanceCriteria`, activity, labels, assignee, links). |
| `hive_list_issues({ state?, label?, assignee?, workspace? })` | Lightweight summaries, optionally filtered. |
| `hive_create_issue({ title, description?, parent?, labels?, acceptance_criteria?, state? })` | New issue / sub-task. |
| `hive_update_issue({ id, title?, description?, labels?, assignee?, parent? })` | Patch fields (NOT state). |
| `hive_set_state({ id, state, note? })` | Change state + log it. |
| `hive_add_comment({ id, message })` | Append a markdown comment to the activity log. |
| `hive_mark_acceptance({ id, index, done })` | Tick/untick a 0-based criterion. |
| `hive_link_issue` · `hive_move_issue` · `hive_list_workspaces` | Cross-repo links, transfers, discovery. |
| `hive_delete_issue({ id })` | Destructive — only on explicit user ask. |

## Conventions

- Comments are markdown. Keep them short. Use file:line refs.
- Don't restate the issue's title or description back in comments — assume the reader can see them.
- Use `state: "blocked"` for external dependencies (waiting on review, on a third party, on a missing decision). Don't use it for "I'm tired" — that's `in_progress`.
