# CLAUDE — Project Context for hivemind

You are working in a **hivemind**-tracked project. Issues, tasks, cycles, and
acceptance criteria live as markdown files under `.hivemind/issues/` and are
exposed to you through the **`hive` MCP server** (see `.mcp.json` at the repo
root). You also have access to a Skill at `.claude/skills/hive-work/SKILL.md`
that codifies the workflow contract.

## Identity & Tools

- **MCP server:** `hive` — exposes `mcp__hive__*` tools for every issue
  operation (read, list, create, comment, mark acceptance, set state, delete).
- **Skill:** `hive-work` — auto-triggers when the user mentions an issue key
  matching `^[A-Z]+-\d+` (e.g. `PAY-42`).
- **CLI fallback:** the same operations are available via `hive <subcommand>`
  on PATH. Prefer the MCP tools when the agent (you) is acting; reserve the
  CLI for human-driven invocation.

## Working an Issue (Execution Contract)

When the user asks you to work on `$ISSUE_KEY`:

1. `mcp__hive__hive_get_issue({ id: $ISSUE_KEY })` — load context: title,
   description, acceptance criteria, recent activity.
2. **Claim it FIRST (REQUIRED)** — set both, so the board shows the issue is
   active AND who's on it (owned by you, not guessed by the UI):
   `mcp__hive__hive_set_state({ id: $ISSUE_KEY, state: "in_progress" })` +
   `mcp__hive__hive_update_issue({ id: $ISSUE_KEY, assignee: { type: "agent", id: "claude" } })`.
   Skip the state set only if already `in_progress`.
3. **Branch** (if the repo uses feature branches) — `git switch -c $ISSUE_KEY`
   to isolate from other agents. Skip if trunk-based / already on one.
4. **Plan briefly** (1 paragraph in a comment via `mcp__hive__hive_add_comment`).
5. **Execute** — edit code. As each acceptance criterion is
   satisfied, call `mcp__hive__hive_mark_acceptance({ id, index, done: true })`.
6. **Verify & commit (before review)** — run the repo's tests/typecheck/build and
   make them pass; then `git commit -am "$ISSUE_KEY: <what changed>"`. Do NOT push
   unless explicitly asked.
7. **Comment progress** when meaningful — `mcp__hive__hive_add_comment` with a
   short summary + file:line refs. Don't restate the issue body. Review feedback
   that arrives (e.g. `Review comment on x.ts:42 …`) → log it via
   `hive_add_comment`, address it, re-commit.
8. **FINAL DISPOSITION (REQUIRED)** — every working session must end with a
   `mcp__hive__hive_set_state` call. One of:
   - `in_review` — work complete, waiting for human review
   - `done` — only with explicit user authority
   - `blocked` — cannot proceed; include `note` explaining what's blocked
   - `in_progress` — still going, will resume next session

   **Do not exit a session silently.** A run without a final state change
   leaves the issue stale and breaks the team's view of progress.

## Comments & Conventions

- Comments are markdown. Short. file:line refs preferred.
- Skip restating the title/description — the reader can see them.
- `state: blocked` is for external dependencies (review, third party,
  unresolved decision). Not for fatigue — use `in_progress` for that.
- Sub-tasks: if an issue is too big, create one via
  `mcp__hive__hive_create_issue({ title, parent: $ISSUE_KEY })`. Children inherit
  the parent's id (e.g. `PAY-42.1`).

## Multi-agent workflows (when running inside hivemind)

If you're an agent in a hivemind tile, you can orchestrate a FLEET of sibling
agents as visible canvas tiles. The `hive-workflow` skill (at
`.claude/skills/hive-workflow/SKILL.md`) has the full playbook; the short version:

- `mcp__hive__hive_spawn_agent({ prompt, frame?, supervise? })` — delegate one
  subtask; it auto-reports its result back into your session when done.
- `mcp__hive__hive_workflow({ shape, … })` — run a whole fleet in one blocking
  call. `shape: "fanout"` (one worker per `items[i]`, `{item}` templated, parallel),
  `"mapreduce"` (fanout + a reducer over `{results}`), or `"pipeline"` (sequential
  `stages`, each may use `{input}`). Returns every worker's reply aggregated.

Use a workflow when an issue decomposes into independent units (review N files,
summarize N modules, try N approaches). For dynamic control flow drive
`hive_spawn_agent`/`hive_read`/`hive_connect` directly — see the skill.

## Code Conventions for This Repo

(Add project-specific rules below — language, formatter, test runner, etc.
Hive itself doesn't impose any; the workspace owner does.)

- TBD by repo owner
