/**
 * Templates written by `hive init` into the project root.
 *
 * Multica's split: AGENTS.md is a one-paragraph pointer; CLAUDE.md is the
 * source of truth. Codex/Gemini/opencode auto-discover AGENTS.md and follow
 * the pointer. Avoids duplicating instructions for multi-agent setups.
 */

export const AGENTS_MD = `# AGENTS.md

This project tracks issues and tasks with **hive** (filesystem-only,
markdown-backed; lives in \`.hivemind/\`).

Run \`hive --help\` for commands. The single source of truth for project
conventions is **CLAUDE.md** at the project root — read that first. The
active open issues are summarized in \`.hivemind/.agent.md\`
(auto-regenerated on every change).

Reference issues with \`@<ID>\` syntax (e.g. \`@PAY-118\`).
`;

export const CLAUDE_MD_SECTION = `## Issue tracking with \`hive\`

This project uses **hive** — a filesystem-only, markdown-backed issue tracker
in \`.hivemind/\`. No database, no server. Every issue is a markdown file
with YAML frontmatter and a body of Description / Acceptance criteria /
Activity sections.

### Where things live

\`\`\`
.hivemind/
├── config.yaml              # prefix, next_id, detected agents
├── issues/
│   ├── <ID>.md              # one file per issue
│   └── <PARENT>/            # sub-issues nested under parent dir
│       └── <PARENT>.N.md
└── .agent.md                # auto-generated context (READ ME FIRST)
\`\`\`

### Reading state

- **Start every session by \`cat .hivemind/.agent.md\`** — it lists active
  issues grouped by state, with \`@<ID>\` mentions.
- To read a specific issue: \`hive show @PAY-118\` (or \`hive @PAY-118\`).
- To list filtered: \`hive list --state in_progress --json\`.

### Writing state

Always call \`hive\` instead of editing markdown by hand — it keeps the
activity log, \`updated\` timestamp, and \`.agent.md\` regenerated.

\`\`\`
hive new "Title" [--label bug] [--parent ID] [--assignee NAME]
hive update <ID> --state in_review --note "what changed"
hive task add <ID> "subtask title"
hive task done <ID> <SUBID>
hive link <ID> --parent <PARENT>
hive close <ID>   # state → done
hive reopen <ID>
\`\`\`

### Mention syntax

\`@PAY-118\` in any text resolves to the issue. Use it in commit messages,
PR descriptions, terminal prompts. Run \`hive @PAY-118\` to expand a mention
inline.

### Conventions

- **State** values: \`backlog | todo | in_progress | in_review | done | cancelled\`.
- **Assignee** is polymorphic — either a member or an agent (\`--assignee claude\`
  treats it as an agent automatically; \`--assignee-type member --assignee sarah\`
  for humans). Multica-style.
- **Sub-issues** carry IDs like \`PAY-122.1\` (parent.child); arbitrary depth.
- All commands support \`--json\` for scripting.
`;

/** Returns the snippet to APPEND to an existing CLAUDE.md (vs overwriting). */
export function claudeMdInclude(): string {
  return `\n\n<!-- hivemind:start -->\n${CLAUDE_MD_SECTION}\n<!-- hivemind:end -->\n`;
}

/** Returns a brand-new CLAUDE.md (for projects without one). */
export function freshClaudeMd(projectName: string): string {
  return `# CLAUDE.md

This file provides guidance to Claude Code when working with code in this
repository.

## Project: ${projectName}

(Add your project's coding rules here.)

<!-- hivemind:start -->
${CLAUDE_MD_SECTION}
<!-- hivemind:end -->
`;
}

export const GITIGNORE_LINES = [".hivemind/.agent.md", ""].join("\n");

// ── Agentic templates (hive init --agentic) ──────────────────────────────

/** CLAUDE.md section that turns a plain hive workspace into an
 *  agent-driven one: tells claude about the MCP tool surface + execution
 *  contract. Wrapped in markers so it can co-exist with the baseline
 *  `<!-- hivemind:start -->` section AND be re-applied idempotently. */
export const AGENTIC_CLAUDE_SECTION = `## Agentic mode — MCP tools for claude

This workspace has the **\`hive\` MCP server** auto-loaded via \`.mcp.json\`.
When you (claude) act on an issue, use \`mcp__hive__*\` tools — NOT the
\`hive\` CLI via Bash. Reserve the CLI for human use.

### Tools available

- \`mcp__hive__get_issue({ id })\` — load full context (title, description,
  acceptance criteria, recent activity).
- \`mcp__hive__list_issues({ state?, label?, assignee? })\`
- \`mcp__hive__set_state({ id, state, note? })\` — backlog | todo |
  in_progress | in_review | done | cancelled
- \`mcp__hive__add_comment({ id, message })\`
- \`mcp__hive__mark_acceptance({ id, index, done })\` — 0-based
- \`mcp__hive__update_issue({ id, title?, description?, labels?, ... })\`
- \`mcp__hive__create_issue({ title, parent?, labels?, state? })\`
- \`mcp__hive__delete_issue({ id })\` — destructive; only on explicit ask

### Execution contract (REQUIRED)

When the user asks you to work on an issue (e.g. \`PAY-42\`):

1. \`hive_get_issue\` → load context.
2. Plan briefly (one comment via \`hive_add_comment\`).
3. Execute. Mark each criterion done as you go (\`hive_mark_acceptance\`).
4. Comment progress at meaningful checkpoints (file:line refs).
5. **Every session MUST end with \`hive_set_state\`** with one of:
   - \`in_review\` — work complete, awaiting human review
   - \`done\` — only with explicit user authority
   - \`blocked\` — cannot proceed; include \`note\` explaining what's blocked
   - \`in_progress\` — still going, will resume

Do not exit a session silently.

### Sub-tasks

If an issue is too big, break it down via
\`mcp__hive__create_issue({ title, parent: $KEY })\`. Children inherit the
parent's id (e.g. \`PAY-42.1\`).

### Multi-agent control plane (when running inside hivemind)

If you are an agent in a hivemind tile, you can also DRIVE THE CANVAS — spawn and
coordinate other agents. (These no-op with "app not running" if hivemind isn't
up, so they're safe to try.)

- \`mcp__hive__hive_spawn_agent({ prompt, agent?, frame?, supervise? })\` —
  delegate a subtask to a sibling agent. It AUTO-REPORTS its result back into your
  session when done (no polling). \`frame\` picks the workspace (id / repo name /
  title — discover via \`hive_list_frames\`); \`supervise\` routes the worker's
  tool-permission prompts to YOU (answer with \`hive_approve\`).
- \`mcp__hive__hive_send({ tileId, text })\` / \`hive_send_keys({ tileId, keys })\`
  — send a follow-up, or key tokens (e.g. \`["Down","Enter"]\`) to drive a
  worker's interactive picker (e.g. its AskUserQuestion).
- \`mcp__hive__hive_read({ tileId })\` — optionally block for a worker's reply.
- \`mcp__hive__hive_approve({ reqId, decision })\` — answer a supervised worker:
  \`allow\` | \`deny\` | \`always\` | \`never\`.
- \`mcp__hive__hive_list_frames()\` / \`hive_list_tiles({ frame? })\` — discover
  frames and the agents in them (grouped, with live status).
- \`mcp__hive__hive_focus\` / \`hive_close_tile\` / \`hive_connect\` /
  \`hive_report\` — focus a tile, close a worker, pipe one agent into another, or
  report a result up to your parent.

Delegate generously: fire a worker and keep working — its reply lands in your
inbox when it's done.

### Multi-agent workflows (fan-out / pipeline / map-reduce)

To orchestrate a FLEET of workers in one call, use
\`mcp__hive__hive_workflow({ shape, … })\` — it spawns the workers as visible
tiles, drives them, and BLOCKS until they're done, returning their replies
aggregated. Pick a \`shape\`:

- \`fanout\` — one worker per \`items[i]\`, run in parallel; \`prompt\` is a
  template with a \`{item}\` placeholder. (e.g. review N files at once.)
- \`mapreduce\` — a fanout, then ONE reducer agent fed all outputs via
  \`reduce_prompt\` (\`{results}\` = joined outputs).
- \`pipeline\` — a sequential chain; \`stages\` is an array of prompts, each may
  use \`{input}\` to reference the prior stage's reply.

Add \`supervise\` to broker the workers' tool prompts to you, \`frame\` to target a
workspace, \`max_concurrent\` (default 6) to bound parallelism. For dynamic control
flow a fixed shape can't express (loop-until-done, judge panels), drive
\`hive_spawn_agent\`/\`hive_read\`/\`hive_connect\` yourself — the \`hive-workflow\`
skill has the patterns.
`;

export function agenticClaudeAppend(): string {
  return `\n\n<!-- hivemind:agentic:start -->\n${AGENTIC_CLAUDE_SECTION}\n<!-- hivemind:agentic:end -->\n`;
}

/** `.mcp.json` content for a workspace. \`hiveCliPath\` is an absolute path
 *  to the \`hive\` binary (installed) OR to the TS source (dev). */
export function mcpJson(hiveCliPath: string, hiveRoot: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        hive: hiveCliPath.endsWith(".ts")
          ? {
              command: "bun",
              args: ["run", hiveCliPath, "mcp-stdio"],
              env: { HIVE_ROOT: hiveRoot, HIVE_AGENT_ID: "claude" },
            }
          : {
              command: hiveCliPath,
              args: ["mcp-stdio"],
              env: { HIVE_ROOT: hiveRoot, HIVE_AGENT_ID: "claude" },
            },
      },
    },
    null,
    2,
  );
}

export const HIVE_WORK_SKILL = `---
name: hive-work
description: Use whenever the user references a hivemind issue key (e.g. PAY-42, BUG-7, anything matching ^[A-Z]+-\\\\d+) or asks to update an issue's status, add a comment, mark acceptance criteria done, or complete work on an issue. Always use mcp__hive__* tools — do NOT use the Bash tool to invoke the hive CLI directly.
---

# Working a hivemind issue (Execution Contract)

**Always use the \`mcp__hive__*\` tools — never shell out to the \`hive\` CLI via
Bash.** The MCP tools keep the activity log, \`updated\` timestamp, and the board's
live view in sync; the CLI is for humans. Every tool below works cross-repo: an id
whose prefix belongs to another *registered* workspace resolves automatically.

When you start work on issue \`$KEY\`:

1. **Load context** — call \`mcp__hive__hive_get_issue({ id: $KEY })\`. Read the title, description, and \`acceptanceCriteria\` array.

2. **Claim it (REQUIRED, do this FIRST)** — in one move, take ownership:
   - \`mcp__hive__hive_set_state({ id: $KEY, state: "in_progress" })\` (skip only if already in_progress)
   - \`mcp__hive__hive_update_issue({ id: $KEY, assignee: { type: "agent", id: "claude" } })\` so the board shows WHO is on it.
   Status + assignee are owned by you (the agent) via these calls — the UI does
   not guess them. This is what makes the canvas/board reflect live agent activity.

3. **Branch (if the repo uses feature branches)** — isolate your work so parallel
   agents don't collide: \`git switch -c $KEY\` (or reuse an existing branch named
   for the issue). Skip if the repo works trunk-based or you're already on a
   suitable branch.

4. **Plan** — outline the steps to complete each criterion. Post the plan as a comment via \`mcp__hive__hive_add_comment\` (one paragraph, no preamble).

5. **Execute** — do the actual work using Edit / Write / Bash for code changes. After completing each criterion, call \`mcp__hive__hive_mark_acceptance({ id: $KEY, index: N, done: true })\`.

6. **Verify & commit (REQUIRED before review)** — run the repo's tests / typecheck / build (whatever it has) and make them pass. Then commit your work with the issue id in the message: \`git commit -am "$KEY: <what changed>"\`. **Do NOT push** unless the user explicitly asked — pushing is a human-authorised action. Committing locally is expected.

7. **Report progress** — when meaningful work is done, post a comment summarising what you did and pointing at the changes (file:line refs).

8. **Final disposition (REQUIRED)** — end EVERY work session with one of:
   - \`mcp__hive__hive_set_state({ id: $KEY, state: "in_review" })\` — work complete, awaiting human review
   - \`mcp__hive__hive_set_state({ id: $KEY, state: "done" })\` — only if you have explicit authority
   - \`mcp__hive__hive_set_state({ id: $KEY, state: "blocked", note: "<why>" })\` — cannot proceed; explain
   - \`mcp__hive__hive_set_state({ id: $KEY, state: "in_progress" })\` — still going; will resume next session

**Do not exit silently.** Failing to call \`hive_set_state\` leaves the issue in a stale state and breaks the team's view of what's happening.

## Handling review feedback

When a human leaves a review comment on your diff (it arrives as a prompt like
\`Review comment on src/x.ts:42 (new): <text>\`):

1. **Record it on the issue** — \`mcp__hive__hive_add_comment({ id: $KEY, message: "review: <file:line> — <comment>" })\` so the feedback is durable in the issue's activity log, not just in your terminal.
2. **Address it** — make the change, re-verify, and commit (\`git commit -am "$KEY: address review on <file>"\`).
3. If you'd marked it \`in_review\`, set it back to \`in_progress\` while you work, then \`in_review\` again when done.

## Sub-tasks

If the issue is too large, break it down via \`mcp__hive__hive_create_issue({ title, parent: $KEY })\`. New sub-issues inherit the parent's id (e.g. PAY-42.1). Put acceptance criteria in the \`acceptance_criteria\` string-array argument (NOT inside \`description\`) so they land in the tickable checklist. \`hive_create_issue\` also takes \`labels\` and an initial \`state\`.

## Cross-repo & linking

In a multi-repo setup, hive can reach issues in OTHER registered workspaces:

- \`mcp__hive__hive_list_workspaces()\` — list every registered workspace with its prefix, title, and repo path. Use it to discover where you can move or link.
- \`mcp__hive__hive_list_issues({ workspace: "OPS", state?, label?, assignee? })\` — pass a \`workspace\` prefix to list ANOTHER repo's issues; omit for the current one.
- \`mcp__hive__hive_link_issue({ id, other_id, type })\` — link two issues across (or within) repos. \`type\` ∈ \`relates\` (default) | \`blocks\` | \`blocked-by\` | \`duplicates\` | \`parent-of\` | \`child-of\`; the reciprocal is recorded automatically. For the single-repo parent hierarchy use \`hive_update_issue({ parent })\` instead.
- \`mcp__hive__hive_move_issue({ id, to_workspace, mode })\` — transfer an issue to another workspace by prefix. \`mode: "move"\` (default) deletes the source and stamps the new issue \`moved-from\`; \`mode: "copy"\` keeps the source and links both with \`relates\`. Refuses issues that have sub-issues.

## Full issue toolset

| Tool | Purpose |
|---|---|
| \`hive_get_issue({ id })\` | Load one issue (title, description, \`acceptanceCriteria\`, activity, labels, assignee, links). |
| \`hive_list_issues({ state?, label?, assignee?, workspace? })\` | Lightweight summaries, optionally filtered. |
| \`hive_create_issue({ title, description?, parent?, labels?, acceptance_criteria?, state? })\` | New issue / sub-task. |
| \`hive_update_issue({ id, title?, description?, labels?, assignee?, parent? })\` | Patch fields (NOT state). |
| \`hive_set_state({ id, state, note? })\` | Change state + log it. |
| \`hive_add_comment({ id, message })\` | Append a markdown comment to the activity log. |
| \`hive_mark_acceptance({ id, index, done })\` | Tick/untick a 0-based criterion. |
| \`hive_link_issue\` · \`hive_move_issue\` · \`hive_list_workspaces\` | Cross-repo links, transfers, discovery. |
| \`hive_delete_issue({ id })\` | Destructive — only on explicit user ask. |

## Conventions

- Comments are markdown. Keep them short. Use file:line refs.
- Don't restate the issue's title or description back in comments — assume the reader can see them.
- Use \`state: "blocked"\` for external dependencies (waiting on review, on a third party, on a missing decision). Don't use it for "I'm tired" — that's \`in_progress\`.
`;

export const SAMPLE_ISSUE_BODY = `## Description

Brief description of what needs to be done and why.

## Acceptance criteria

- [ ] First check
- [ ] Second check

## Activity
`;

// hive-browser skill — base64-encoded so the markdown's many backticks/code
// fences survive as a TS string. Decoded by hiveBrowserSkill() at install time;
// kept in sync with templates/agentic/.claude/skills/hive-browser/SKILL.md.
export const HIVE_BROWSER_SKILL_B64 =
  "LS0tCm5hbWU6IGhpdmUtYnJvd3NlcgpkZXNjcmlwdGlvbjogPi0KICBEcml2ZSBhIEJyb3dzZXIgdGlsZSBvbiB0aGUgaGl2ZW1pbmQgY2FudmFzIGZyb20gaW5zaWRlIGFuIGFnZW50IHNlc3Npb24g4oCUCiAgbmF2aWdhdGUgcGFnZXMsIGNsaWNrLCBmaWxsIGZvcm1zLCByZWFkIGNvbnRlbnQsIGFuZCBzY3JlZW5zaG90IHRoZSBTQU1FCiAgYnJvd3NlciB0aWxlIHRoZSB1c2VyIGlzIHdhdGNoaW5nLCB1c2luZyB0aGUgQ2hyb21lIERldlRvb2xzIFByb3RvY29sLiBVc2UgdGhpcwogIHdoZW5ldmVyIHlvdSAoYW4gYWdlbnQgcnVubmluZyBpbiBhIGhpdmVtaW5kIHRpbGUpIGFyZSBhc2tlZCB0byBicm93c2UgdGhlIHdlYiwKICBvcGVuIGEgc2l0ZSwgbG9vayBzb21ldGhpbmcgdXAgb25saW5lLCBsb2cgaW50byBhIHBhZ2UsIGZpbGwgYSB3ZWIgZm9ybSwgc2NyYXBlCiAgb3IgcmVhZCBhIHdlYiBwYWdlLCBjaGVjayBhIGRhc2hib2FyZCwgY2xpY2sgYXJvdW5kIGEgd2ViIGFwcCwgb3IgdGFrZSBhCiAgc2NyZWVuc2hvdCBvZiBhIHdlYnNpdGUg4oCUIGFueXRoaW5nIHRoYXQgbmVlZHMgYSByZWFsIGJyb3dzZXIuIEFsc28gdXNlIGl0IHdoZW4KICB0aGUgdXNlciBzYXlzICJvcGVuIHRoaXMgaW4gdGhlIGJyb3dzZXIiLCAidXNlIHRoZSBicm93c2VyIHRpbGUiLCAiZ28gdG8KICA8dXJsPiIsICJzZWFyY2ggdGhlIHdlYiBmb3IiLCBvciByZWZlcmVuY2VzIGEgQnJvd3NlciB0aWxlIG9uIHRoZWlyIGNhbnZhcy4KICBUaGlzIHdyYXBzIHZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXIgcG9pbnRlZCBhdCB0aGUgY2FudmFzJ3MgbGl2ZSBicm93c2VyIHRpbGUsCiAgc28gdGhlIHVzZXIgc2VlcyBldmVyeSBhY3Rpb24gaGFwcGVuIG9uIHRoZWlyIHNjcmVlbi4KLS0tCgojIGhpdmUtYnJvd3NlcgoKWW91IGFyZSBhbiBhZ2VudCBydW5uaW5nIGluc2lkZSBhICoqaGl2ZW1pbmQqKiB0aWxlIChhIHRlcm1pbmFsIG9uIGFuIGluZmluaXRlCmNhbnZhcykuIFRoZSBjYW52YXMgY2FuIGhvc3QgKipCcm93c2VyIHRpbGVzKiog4oCUIHJlYWwgQ2hyb21pdW0gd2ViIHZpZXdzIHRoZQp1c2VyIGNhbiBzZWUuIFRoaXMgc2tpbGwgbGV0cyB5b3UgKmRyaXZlKiBvbmUgb2YgdGhvc2UgdGlsZXM6IHNhbWUgcGl4ZWxzIHRoZQp1c2VyIGlzIHdhdGNoaW5nLCBjb250cm9sbGVkIG92ZXIgdGhlIENocm9tZSBEZXZUb29scyBQcm90b2NvbCAoQ0RQKSB1c2luZyB0aGUKW2BhZ2VudC1icm93c2VyYF0oaHR0cHM6Ly9naXRodWIuY29tL3ZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXIpIENMSS4KCllvdSBhcmUgKipub3QqKiBzcGF3bmluZyBhIGhpZGRlbiBoZWFkbGVzcyBicm93c2VyLiBZb3UgYXR0YWNoIHRvIHRoZSB1c2VyJ3MKdmlzaWJsZSB0aWxlLCBhY3QgaW4gaXQsIGFuZCB0aGV5IHdhdGNoIGl0IGhhcHBlbi4gVGhhdCBzaGFyZWQgY29udGV4dCBpcyB0aGUKd2hvbGUgcG9pbnQuCgojIyBIb3cgaXQgd29ya3MgKHRoZSBtZW50YWwgbW9kZWwpCgotIEVhY2ggQnJvd3NlciB0aWxlIGlzIGFuIEVsZWN0cm9uIGA8d2Vidmlldz5gIHdpdGggaXRzICoqb3duKiogd2ViQ29udGVudHMuCi0gaGl2ZW1pbmQgZXhwb3NlcyBhICoqbG9vcGJhY2sqKiBDRFAgcG9ydCAod2hlbiBlbmFibGVkKSBhbmQgd3JpdGVzIGEKICAqKmRpc2NvdmVyeSBmaWxlKiogbGlzdGluZyB0aGUgb3BlbiBicm93c2VyIHRpbGVzICh0aWxlIGlkLCBmcmFtZSwgVVJMKS4KLSBgYWdlbnQtYnJvd3NlciAtLWNkcCA8cG9ydD5gIGNvbm5lY3RzIHRvIHRoYXQgZW5kcG9pbnQ7IHlvdSBwaWNrIHRoZSB0YWIgdGhhdAogIGlzIHRoZSB1c2VyJ3MgdGlsZSBhbmQgZHJpdmUgaXQgd2l0aCBgb3BlbmAgLyBgc25hcHNob3RgIC8gYGNsaWNrYCAvIGBmaWxsYCAvCiAgYHNjcmVlbnNob3RgLgoKIyMgU3RlcCAwIOKAlCBQcmVjb25kaXRpb25zIChjaGVjayB0aGVzZSBmaXJzdCkKClJ1biB0aGVzZSBhbmQgcmVhc29uIGFib3V0IHRoZSBvdXRwdXQgYmVmb3JlIGRvaW5nIGFueXRoaW5nIGVsc2U6CgpgYGBiYXNoCiMgSXMgdGhlIENEUCBicmlkZ2UgZW5hYmxlZCwgYW5kIHdoZXJlIGlzIHRoZSBkaXNjb3ZlcnkgZmlsZT8KZWNobyAidGFyZ2V0cz0kSElWRU1JTkRfQlJPV1NFUl9UQVJHRVRTICBwb3J0PSRISVZFTUlORF9CUk9XU0VSX0NEUF9QT1JUIgpjYXQgIiRISVZFTUlORF9CUk9XU0VSX1RBUkdFVFMiIDI+L2Rldi9udWxsIHx8IGVjaG8gIk5PX0RJU0NPVkVSWV9GSUxFIgpgYGAKCkludGVycHJldDoKCi0gKipgcG9ydD1gIGlzIGVtcHR5IC8gYGNkcEVuYWJsZWQ6ZmFsc2VgIGluIHRoZSBmaWxlKiog4oaSIHRoZSBDRFAgYnJpZGdlIGlzCiAgT0ZGLiBJdCBpcyBvcHQtaW4gZm9yIHNhZmV0eSAoYSBkZWJ1ZyBwb3J0IGFsc28gZXhwb3NlcyB0aGUgYXBwIHdpbmRvdykuIFRlbGwKICB0aGUgdXNlciB0byBlbmFibGUgaXQ6ICoqU2V0dGluZ3MgKGdlYXIsIHRvcC1yaWdodCkg4oaSICJFbmFibGUgYWdlbnQgYnJvd3NlcgogIGNvbnRyb2wiIOKGkiBSZWxhdW5jaCB0byBhcHBseSoqIChvciBzZXQgYEhJVkVNSU5EX0JST1dTRVJfQ0RQPTFgIGluIHRoZQogIGVudmlyb25tZW50IGJlZm9yZSBsYXVuY2gpLiBUaGVuIHJldHJ5LiBEbyBub3QgdHJ5IHRvIHdvcmsgYXJvdW5kIHRoaXMuCi0gKipgTk9fRElTQ09WRVJZX0ZJTEVgIG9yIGB0aWxlczogW11gKiog4oaSIG5vIEJyb3dzZXIgdGlsZSBpcyBvcGVuLiBBc2sgdGhlIHVzZXIKICB0byBvcGVuIG9uZSAoY2FudmFzIGhvdGtleSAqKmA3YCoqLCBvciBhIGZyYW1lJ3MgKiorIOKGkiBCcm93c2VyKiopLCBpZGVhbGx5IGluCiAgdGhlICoqc2FtZSBmcmFtZSoqIGFzIHlvdXIgdGlsZS4gVGhlbiByZS1yZWFkIHRoZSBmaWxlLgotICoqYHRpbGVzOmAgaGFzIGVudHJpZXMqKiDihpIgZ29vZCwgY29udGludWUuCgpNYWtlIHN1cmUgdGhlIGBhZ2VudC1icm93c2VyYCBDTEkgaXMgcmVhY2hhYmxlLiBQcmVmZXIgYSBnbG9iYWwgaW5zdGFsbCBpZiBvbmUKZXhpc3RzOyBvdGhlcndpc2UgcnVuIGl0IG9uIGRlbWFuZCB3aXRoIGBucHhgIOKAlCBpdCBmZXRjaGVzIGFuZCBjYWNoZXMgdGhlIG5hdGl2ZQpiaW5hcnkgb24gZmlyc3QgdXNlLCBzbyB0aGVyZSdzICoqbm8gZ2xvYmFsIGluc3RhbGwgYW5kIG5vIGV4dHJhIHBlcm1pc3Npb25zKio6CgpgYGBiYXNoCkFCPSJhZ2VudC1icm93c2VyIjsgY29tbWFuZCAtdiBhZ2VudC1icm93c2VyID4vZGV2L251bGwgfHwgQUI9Im5weCAteSBhZ2VudC1icm93c2VyIgokQUIgLS12ZXJzaW9uICAgICMgc2FuaXR5IGNoZWNrIChmZXRjaGVzIG9uIGZpcnN0IG5weCBydW4pCmBgYAoKVXNlICoqYCRBQmAqKiB3aGVyZXZlciBhIGNvbW1hbmQgYmVsb3cgc2F5cyBgYWdlbnQtYnJvd3NlcmAuIFlvdSBkbyAqKm5vdCoqIG5lZWQKdG8gcnVuIGBhZ2VudC1icm93c2VyIGluc3RhbGxgIOKAlCB0aGF0IGRvd25sb2FkcyBhIGJ1bmRsZWQgQ2hyb21lIHdlIGRvbid0IHVzZTsKd2UgYXR0YWNoIHRvIHRoZSBjYW52YXMgdGlsZSBvdmVyIENEUCBpbnN0ZWFkLiAoSWYgYG5weGAgaXRzZWxmIGlzIG1pc3NpbmcsIE5vZGUKaXNuJ3QgaW5zdGFsbGVkIOKAlCB0ZWxsIHRoZSB1c2VyLCBzaW5jZSB0aGUgQ0xJIG5lZWRzIGl0LikKCiMjIFN0ZXAgMSDigJQgUGljayB0aGUgcmlnaHQgdGlsZQoKUmVhZCB0aGUgZGlzY292ZXJ5IGZpbGUuIEVhY2ggZW50cnkgbG9va3MgbGlrZToKCmBgYGpzb24KeyAidGlsZUlkIjogInRpbGUtYnJvd3Nlci0xNzMwMDAwMDAwMDAwIiwgImZyYW1lSWQiOiAiZnJhbWUtLi4uIiwgInVybCI6ICJodHRwczovL2R1Y2tkdWNrZ28uY29tIiB9CmBgYAoKLSAqKkV4YWN0bHkgb25lIHRpbGUqKiDihpIgdXNlIGl0LiBFYXN5LgotICoqU2V2ZXJhbCB0aWxlcyoqIOKGkiBwcmVmZXIgdGhlIG9uZSBpbiB5b3VyIG93biBmcmFtZSBpZiB5b3UgY2FuIHRlbGwgd2hpY2gKICBmcmFtZSB5b3UgYXJlIGluOyBvdGhlcndpc2Ugc2hvdyB0aGUgdXNlciB0aGUgbGlzdCAoVVJMcyArIGZyYW1lcykgYW5kIGFzawogIHdoaWNoIG9uZSB0byBkcml2ZS4gTmV2ZXIgZ3Vlc3Mgc2lsZW50bHkgd2hlbiBpdCdzIGFtYmlndW91cyDigJQgeW91IG1pZ2h0CiAgaGlqYWNrIGEgdGFiIHRoZSB1c2VyIGlzIHVzaW5nLgoKTm90ZSB0aGUgY2hvc2VuIHRpbGUncyAqKmB1cmxgKiog4oCUIHlvdSdsbCB1c2UgaXQgdG8gaWRlbnRpZnkgdGhlIGxpdmUgQ0RQIHRhYi4KCiMjIFN0ZXAgMiDigJQgQ29ubmVjdCBhbmQgc2VsZWN0IHRoZSB0YWIKCmBhZ2VudC1icm93c2VyYCB0YWxrcyB0byB0aGUgZW5kcG9pbnQ7IHRoZSBFbGVjdHJvbiBhcHAgZXhwb3NlcyAqKmFsbCoqIGl0cwpwYWdlcyBhcyB0YWJzICh5b3VyIHRpbGUncyB3ZWIgdmlldyAqYW5kKiB0aGUgYXBwJ3Mgb3duIHdpbmRvdykuIExpc3QgdGhlbSBhbmQKc3dpdGNoIHRvIHRoZSBvbmUgd2hvc2UgVVJMIG1hdGNoZXMgeW91ciBjaG9zZW4gdGlsZToKCmBgYGJhc2gKJEFCIGNvbm5lY3QgIiRISVZFTUlORF9CUk9XU0VSX0NEUF9QT1JUIiAgICMgY29ubmVjdCBvbmNlOyBsYXRlciBjb21tYW5kcyBvbWl0IC0tY2RwCiRBQiB0YWIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBsaXN0IHRhYnM6IHNob3dzIHQxL3Qy4oCmICsgVVJMcwokQUIgdGFiIHQ8Tj4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgc3dpdGNoIHRvIFlPVVIgdGlsZSdzIHRhYiAobWF0Y2ggdGhlIFVSTCkKYGBgCgooUmVwbGFjZSBgJEFCYCB3aXRoIGBhZ2VudC1icm93c2VyYCBvciBgbnB4IC15IGFnZW50LWJyb3dzZXJgIHBlciBTdGVwIDAuKQoKUGljayB0aGUgdGFiIHdob3NlIFVSTCBtYXRjaGVzIHRoZSBgdXJsYCBmcm9tIFN0ZXAgMS4gKipBdm9pZCB0aGUgYXBwLXNoZWxsCnRhYioqIOKAlCBpdCdzIHRoZSBoaXZlbWluZCBVSSBpdHNlbGYgKGl0cyBVUkwgaXMgYSBgZmlsZTovL+KApi9pbmRleC5odG1sYCBvciBhCmBsb2NhbGhvc3RgIGRldiBVUkwpLCBhbmQgZHJpdmluZyBpdCB3b3VsZCBwb2tlIHRoZSBhcHAsIG5vdCB0aGUgd2ViLiBXaGVuIGluCmRvdWJ0LCB0aGUgd2ViIHRhYiBpcyB0aGUgb25lIHdpdGggYW4gYGh0dHAocyk6Ly9gIFVSTCB5b3UgcmVjb2duaXplLgoKIyMgU3RlcCAzIOKAlCBEcml2ZSBpdCAodGhlIGFnZW50LWJyb3dzZXIgc3VyZmFjZSkKCk9uY2UgdGhlIHJpZ2h0IHRhYiBpcyBhY3RpdmUsIHRoaXMgaXMgbm9ybWFsIGBhZ2VudC1icm93c2VyYC4gQ29yZSBsb29wOgoKYGBgYmFzaAphZ2VudC1icm93c2VyIG9wZW4gaHR0cHM6Ly9leGFtcGxlLmNvbSAgICAgICAgICAjIG5hdmlnYXRlIChhbGlhc2VzOiBnb3RvLCBuYXZpZ2F0ZSkKYWdlbnQtYnJvd3NlciB3YWl0IC0tbG9hZCBuZXR3b3JraWRsZSAgICAgICAgICAgIyBsZXQgaXQgc2V0dGxlCmFnZW50LWJyb3dzZXIgc25hcHNob3QgLWkgICAgICAgICAgICAgICAgICAgICAgICAjIGludGVyYWN0aXZlIGExMXkgdHJlZSB3aXRoIEBlMS9AZTIgcmVmcwphZ2VudC1icm93c2VyIGNsaWNrIEBlMSAgICAgICAgICAgICAgICAgICAgICAgICAgIyBjbGljayBieSByZWYgKG9yIGEgQ1NTIHNlbGVjdG9yKQphZ2VudC1icm93c2VyIGZpbGwgQGUyICJzZWFyY2ggdGV4dCIgICAgICAgICAgICAgIyBjbGVhciArIHR5cGUKYWdlbnQtYnJvd3NlciBwcmVzcyBFbnRlcgphZ2VudC1icm93c2VyIHNuYXBzaG90IC1pICAgICAgICAgICAgICAgICAgICAgICAgIyByZS1zbmFwc2hvdCBhZnRlciB0aGUgcGFnZSBjaGFuZ2VzCmBgYAoKUmVhZGluZyAvIGV4dHJhY3Rpbmc6CgpgYGBiYXNoCmFnZW50LWJyb3dzZXIgc25hcHNob3QgLS1qc29uICAgICAgICAgICAgICAgICAgICAjIGZ1bGwgdHJlZSArIHJlZnMgYXMgSlNPTgphZ2VudC1icm93c2VyIGdldCB0ZXh0IEBlMSAtLWpzb24gICAgICAgICAgICAgICAgIyB0ZXh0IG9mIG9uZSBlbGVtZW50CmBgYAoKU2VlaW5nIHRoZSBwYWdlIChncmVhdCBmb3IgbGF5b3V0IC8gdW5sYWJlbGVkIGljb25zIC8gdmlzdWFsIHN0YXRlKToKCmBgYGJhc2gKYWdlbnQtYnJvd3NlciBzY3JlZW5zaG90IC0tYW5ub3RhdGUgICAgICAgICAgICAgICMgbnVtYmVyZWQgb3ZlcmxheSArIEBlIHJlZnMgeW91IGNhbiBjbGljayBuZXh0CmBgYAoKRWZmaWNpZW5jeSDigJQgY2hhaW4gb3IgYmF0Y2ggc28geW91IGRvbid0IHBheSBwZXItY29tbWFuZCBzdGFydHVwOgoKYGBgYmFzaAphZ2VudC1icm93c2VyIG9wZW4gZXhhbXBsZS5jb20gJiYgYWdlbnQtYnJvd3NlciB3YWl0IC0tbG9hZCBuZXR3b3JraWRsZSAmJiBhZ2VudC1icm93c2VyIHNuYXBzaG90IC1pCmFnZW50LWJyb3dzZXIgYmF0Y2ggIm9wZW4gaHR0cHM6Ly9leGFtcGxlLmNvbSIgInNuYXBzaG90IC1pIiAic2NyZWVuc2hvdCIKYGBgCgpUaGUgY2Fub25pY2FsIEFJIHdvcmtmbG93OiAqKm9wZW4g4oaSIGBzbmFwc2hvdCAtaWAg4oaSIGFjdCBvbiByZWZzIOKGkiByZS1zbmFwc2hvdCoqLgpSZWZzIChgQGUxYCkgY29tZSBmcm9tIHRoZSBsYXRlc3Qgc25hcHNob3Q7IHJlLXNuYXBzaG90IHdoZW5ldmVyIHRoZSBwYWdlCmNoYW5nZXMgb3IgeW91J2xsIGFjdCBvbiBzdGFsZSByZWZzLgoKIyMgR3VhcmRyYWlscwoKLSAqKllvdSBhcmUgc2hhcmluZyB0aGUgdXNlcidzIHNjcmVlbi4qKiBUaGV5IHNlZSBldmVyeSBuYXZpZ2F0aW9uIGFuZCBjbGljay4KICBEb24ndCBuYXZpZ2F0ZSBhd2F5IGZyb20gc29tZXRoaW5nIHRoZXkncmUgbWlkLXRhc2sgb24gd2l0aG91dCBzYXlpbmcgc28uCi0gKipMb2dpbnMgLyBzZW5zaXRpdmUgc2l0ZXM6KiogdGhlIHRpbGUgdXNlcyBhIHBlcnNpc3RlbnQgc2Vzc2lvbgogIChgcGVyc2lzdDpicm93c2VyYCksIHNvIHRoZSB1c2VyIG1heSBhbHJlYWR5IGJlIGxvZ2dlZCBpbi4gRG9uJ3Qgc3VibWl0CiAgY3JlZGVudGlhbHMsIG1ha2UgcHVyY2hhc2VzLCBvciB0YWtlIGRlc3RydWN0aXZlIGFjdGlvbnMgd2l0aG91dCBleHBsaWNpdAogIGNvbmZpcm1hdGlvbi4gYWdlbnQtYnJvd3NlcidzIGAtLWNvbmZpcm0tYWN0aW9uc2AgYW5kIGAtLWFsbG93ZWQtZG9tYWluc2AKICBmbGFncyBleGlzdCBmb3IgdGhpcyDigJQgdXNlIHRoZW0gd2hlbiBhIHRhc2sgdG91Y2hlcyBhbnl0aGluZyByaXNreS4KLSAqKkRvbid0IGRyaXZlIHRoZSBhcHAtc2hlbGwgdGFiLioqIEl0J3MgdGhlIGhpdmVtaW5kIFVJLiBPbmx5IGFjdCBvbiB0aGUgd2ViCiAgdGFiIHdob3NlIFVSTCBtYXRjaGVzIHlvdXIgY2hvc2VuIEJyb3dzZXIgdGlsZS4KLSBJZiBhIGNvbW1hbmQgZmFpbHMgdG8gY29ubmVjdCwgcmUtY2hlY2sgU3RlcCAwIChwb3J0IGVuYWJsZWQ/IHRpbGUgb3Blbj8pCiAgcmF0aGVyIHRoYW4gcmV0cnlpbmcgYmxpbmRseS4KCiMjIFF1aWNrIHJlZmVyZW5jZQoKfCBZb3Ugd2FudCB0b+KApiB8IENvbW1hbmQgfAp8LS0tfC0tLXwKfCBTZWUgaWYgYnJvd3NpbmcgaXMgcG9zc2libGUgfCBgY2F0ICIkSElWRU1JTkRfQlJPV1NFUl9UQVJHRVRTImAgfAp8IENvbm5lY3QgfCBgYWdlbnQtYnJvd3NlciBjb25uZWN0ICIkSElWRU1JTkRfQlJPV1NFUl9DRFBfUE9SVCJgIHwKfCBMaXN0IC8gcGljayB0YWIgfCBgYWdlbnQtYnJvd3NlciB0YWJgIOKGkiBgYWdlbnQtYnJvd3NlciB0YWIgdDxOPmAgfAp8IEdvIHRvIGEgcGFnZSB8IGBhZ2VudC1icm93c2VyIG9wZW4gPHVybD5gIHwKfCBTZWUgaW50ZXJhY3RpdmUgZWxlbWVudHMgfCBgYWdlbnQtYnJvd3NlciBzbmFwc2hvdCAtaWAgfAp8IENsaWNrIC8gdHlwZSB8IGBhZ2VudC1icm93c2VyIGNsaWNrIEBlMWAgwrcgYGFnZW50LWJyb3dzZXIgZmlsbCBAZTIgInR4dCJgIHwKfCBSZWFkIHRleHQgfCBgYWdlbnQtYnJvd3NlciBnZXQgdGV4dCBAZTEgLS1qc29uYCB8CnwgU2NyZWVuc2hvdCB8IGBhZ2VudC1icm93c2VyIHNjcmVlbnNob3QgLS1hbm5vdGF0ZWAgfAoKRnVsbCBjb21tYW5kIHN1cmZhY2U6IGBhZ2VudC1icm93c2VyIC0taGVscGAsIG9yIHRoZSBSRUFETUUgYXQKaHR0cHM6Ly9naXRodWIuY29tL3ZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXIuCg==";
export function hiveBrowserSkill(): string {
  return Buffer.from(HIVE_BROWSER_SKILL_B64, "base64").toString("utf8");
}

// hive-workflow skill — base64-encoded (many code fences) to survive as a TS
// string. Decoded by hiveWorkflowSkill() at install time; kept in sync with
// templates/agentic/.claude/skills/hive-workflow/SKILL.md.
export const HIVE_WORKFLOW_SKILL_B64 =
  "LS0tCm5hbWU6IGhpdmUtd29ya2Zsb3cKZGVzY3JpcHRpb246IFVzZSB3aGVuIHlvdSAoYW4gYWdlbnQgcnVubmluZyBpbiBhIGhpdmVtaW5kIHRpbGUpIG5lZWQgdG8gcnVuIGEgTVVMVEktQUdFTlQgd29ya2Zsb3cg4oCUIGZhbiBhIHRhc2sgb3V0IHRvIHNldmVyYWwgd29ya2VyIGFnZW50cyBpbiBwYXJhbGxlbCwgY2hhaW4gYWdlbnRzIGludG8gYSBwaXBlbGluZSwgbWFwLXJlZHVjZSBvdmVyIGEgbGlzdCwgb3Igb3RoZXJ3aXNlIG9yY2hlc3RyYXRlIGEgZmxlZXQgb2Ygc2libGluZyBhZ2VudHMgb24gdGhlIGNhbnZhcy4gVHJpZ2dlcnMgb24gImZhbiBvdXQiLCAicnVuIE4gYWdlbnRzIiwgImluIHBhcmFsbGVsIiwgIm9yY2hlc3RyYXRlIiwgInNwYXduIHdvcmtlcnMiLCAic3VwZXJ2aXNlIiwgImFwcHJvdmUiLCAic3BsaXQgdGhpcyBhY3Jvc3MgYWdlbnRzIiwgInJldmlldyBhbGwgdGhlc2UgZmlsZXMiLCAibWFwLXJlZHVjZSIsICJkZWxlZ2F0ZSIsICJzcGF3biBhIHBpL2NvZGV4L2Ryb2lkIGFnZW50Iiwgb3Igd2hlbiBhbiBpc3N1ZSBpcyB0b28gYmlnIGZvciBvbmUgYWdlbnQgYW5kIG5hdHVyYWxseSBkZWNvbXBvc2VzIGludG8gaW5kZXBlbmRlbnQgdW5pdHMuIEFsc28gY292ZXJzIGRyaXZpbmcgYSBzcGF3bmVkIHdvcmtlcjogZm9sbG93LXVwIHR1cm5zIChoaXZlX3NlbmQpLCBhbnN3ZXJpbmcgaXRzIHBpY2tlciAoaGl2ZV9zZW5kX2tleXMpLCBnYXRla2VlcGluZyBpdHMgdG9vbHMgKHN1cGVydmlzZSArIGhpdmVfYXBwcm92ZSksIGFuZCBwb2xsaW5nIGZsZWV0IHN0YXR1cyAoaGl2ZV9saXN0X3RpbGVzKS4gUHJlZmVyIHRoZSBgbWNwX19oaXZlX19oaXZlX3dvcmtmbG93YCB0b29sIGZvciBmaXhlZCBzaGFwZXM7IGRyb3AgdG8gcmF3IHNwYXduL3NlbmQvcmVhZC9jb25uZWN0IG9ubHkgZm9yIGR5bmFtaWMgY29udHJvbCBmbG93LgotLS0KCiMgTXVsdGktYWdlbnQgd29ya2Zsb3dzIG9uIHRoZSBoaXZlbWluZCBjYW52YXMKCllvdSBhcmUgYW4gYWdlbnQgaW4gYSBoaXZlbWluZCB0aWxlLiBZb3UgY2FuIHNwYXduICoqc2libGluZyBhZ2VudHMgYXMgdmlzaWJsZQp0aWxlcyoqIGFuZCBvcmNoZXN0cmF0ZSB0aGVtLiBXb3JrZXJzIGFyZSByZWFsIHRpbGVzIHRoZSB1c2VyIHdhdGNoZXMg4oCUIGNoaWxkcmVuCm9mIHlvdSwgZGVwdGgtY2FwcGVkIChtYXggMyBkZWVwKSBhbmQgcmF0ZS1saW1pdGVkLiBUd28gbGF5ZXJzOgoKMS4gKipgbWNwX19oaXZlX19oaXZlX3dvcmtmbG93YCoqIOKAlCBvbmUgYmxvY2tpbmcgY2FsbCBmb3IgdGhlIGNvbW1vbiBzaGFwZXMuIFVzZQogICB0aGlzIGZpcnN0LiBJdCBzcGF3bnMgdGhlIGZsZWV0LCBkcml2ZXMgaXQsIGFuZCByZXR1cm5zIGFnZ3JlZ2F0ZWQgcmVwbGllcy4KMi4gKipSYXcgYG1jcF9faGl2ZV9fKmAqKiAoYGhpdmVfc3Bhd25fYWdlbnRgIC8gYGhpdmVfc2VuZGAgLyBgaGl2ZV9zZW5kX2tleXNgIC8KICAgYGhpdmVfcmVhZGAgLyBgaGl2ZV9jb25uZWN0YCAvIGBoaXZlX2FwcHJvdmVgIC8gYGhpdmVfbGlzdF90aWxlc2AgLwogICBgaGl2ZV9yZXBvcnRgKSDigJQgd2hlbiBjb250cm9sIGZsb3cgaXMgZHluYW1pYyBhbmQgbm8gZml4ZWQgc2hhcGUgZml0cy4KCj4gQWxsIG9mIHRoZXNlIG5vLW9wIHdpdGggImFwcCBub3QgcnVubmluZyIgaWYgaGl2ZW1pbmQgaXNuJ3QgdXAg4oCUIHNhZmUgdG8gdHJ5LgoKKipBdXRvLXJlcG9ydCBpcyB0aGUgZGVmYXVsdC4qKiBBIHNwYXduZWQgd29ya2VyIChhbmQgZXZlcnkgYGhpdmVfd29ya2Zsb3dgCndvcmtlcikgZGVsaXZlcnMgaXRzIHJlcGx5IHN0cmFpZ2h0IGludG8gWU9VUiBzZXNzaW9uIHdoZW4gaXQgZmluaXNoZXMgYSB0dXJuIOKAlAp5b3Ugc2VlIGEgYFtoaXZlXSBmcm9tIDx0aWxlSWQ+OiDigKZgIG1lc3NhZ2UuIFNvIHRoZSBub3JtYWwgcGF0dGVybiBpcwpmaXJlLWFuZC1mb3JnZXQ6IHNwYXduLCBrZWVwIHdvcmtpbmcsIGNvbGxlY3QgdGhlIHJlcG9ydHMgYXMgdGhleSBhcnJpdmUuIE9ubHkKcmVhY2ggZm9yIGBoaXZlX3JlYWRgIHdoZW4geW91IG11c3QgQkxPQ0sgaW5saW5lIGZvciB0aGUgbmV4dCByZXBseS4gVG8gY2hlY2sgd2hvCmlzIHN0aWxsIGJ1c3kgd2l0aG91dCBibG9ja2luZywgcG9sbCBgaGl2ZV9saXN0X3RpbGVzYC4KCiMjIFdoZW4gdG8gdXNlIHdoaWNoCgp8IFlvdSBuZWVk4oCmIHwgVXNlIHwKfC0tLXwtLS18CnwgU2FtZSB0YXNrIG92ZXIgYSBsaXN0LCBpbiBwYXJhbGxlbCB8IGBoaXZlX3dvcmtmbG93KHsgc2hhcGU6ICJmYW5vdXQiIH0pYCB8CnwgRmFuIG91dCArIHN5bnRoZXNpemUgdGhlIHJlc3VsdHMgfCBgaGl2ZV93b3JrZmxvdyh7IHNoYXBlOiAibWFwcmVkdWNlIiB9KWAgfAp8IEEg4oaSIEIg4oaSIEMsIGVhY2ggY29uc3VtaW5nIHRoZSBsYXN0IHwgYGhpdmVfd29ya2Zsb3coeyBzaGFwZTogInBpcGVsaW5lIiB9KWAgfAp8IExvb3AgdW50aWwgYSBjb25kaXRpb24gLyB1bmtub3duIGNvdW50IHwgcmF3IHNwYXduICsgYGhpdmVfcmVhZGAgbG9vcCB8CnwgQSBqdWRnZSBwYW5lbCwgdm90aW5nLCBjb25kaXRpb25hbCBicmFuY2hlcyB8IHJhdyBzcGF3biArIGBoaXZlX3JlYWRgIHwKCiMjIFRoZSB0b29sOiBgaGl2ZV93b3JrZmxvd2AKCiMjIyBmYW5vdXQg4oCUIE4gd29ya2VycyBpbiBwYXJhbGxlbAoKT25lIHdvcmtlciBwZXIgYGl0ZW1zW2ldYC4gYHByb21wdGAgaXMgYSB0ZW1wbGF0ZTsgYHtpdGVtfWAgaXMgZmlsbGVkIHBlciB3b3JrZXIuCkJsb2NrcyB1bnRpbCBhbGwgZmluaXNoLCByZXR1cm5zIGVhY2ggcmVwbHkuCgpgYGAKaGl2ZV93b3JrZmxvdyh7CiAgc2hhcGU6ICJmYW5vdXQiLAogIGl0ZW1zOiBbInNyYy9hdXRoLnRzIiwgInNyYy9wYXkudHMiLCAic3JjL2FwaS50cyJdLAogIHByb21wdDogIlJldmlldyB7aXRlbX0gZm9yIHNlY3VyaXR5IGJ1Z3MuIExpc3QgZmluZGluZ3MgYXMgZmlsZTpsaW5lIOKAlCBvbmUgbGluZSBlYWNoLiIsCiAgbWF4X2NvbmN1cnJlbnQ6IDYKfSkKLy8g4oaSIHsgc2hhcGU6ImZhbm91dCIsIGl0ZW1zOlsge2l0ZW0sIHRpbGVJZCwgc3RhdHVzOiJ0dXJuInwidGltZW91dCJ8ImVycm9yIiwgdGV4dH0sIOKApiBdIH0KYGBgCgojIyMgbWFwcmVkdWNlIOKAlCBmYW5vdXQsIHRoZW4gb25lIHJlZHVjZXIKClJ1bnMgdGhlIGZhbm91dCwgdGhlbiBzcGF3bnMgT05FIHJlZHVjZXIgYWdlbnQgZmVkIGV2ZXJ5IHdvcmtlcidzIG91dHB1dCB2aWEKYHJlZHVjZV9wcm9tcHRgIChge3Jlc3VsdHN9YCA9IGFsbCBvdXRwdXRzIGpvaW5lZCkuCgpgYGAKaGl2ZV93b3JrZmxvdyh7CiAgc2hhcGU6ICJtYXByZWR1Y2UiLAogIGl0ZW1zOiBbImF1dGgiLCAiYmlsbGluZyIsICJzZWFyY2giXSwKICBwcm9tcHQ6ICJTdW1tYXJpemUgdGhlIHtpdGVtfSBtb2R1bGUgaW4gMyBidWxsZXRzLiIsCiAgcmVkdWNlX3Byb21wdDogIkhlcmUgYXJlIG1vZHVsZSBzdW1tYXJpZXM6XG57cmVzdWx0c31cblxuV3JpdGUgYSBvbmUtcGFyYWdyYXBoIGFyY2hpdGVjdHVyZSBvdmVydmlldy4iCn0pCi8vIOKGkiB7IHNoYXBlOiJtYXByZWR1Y2UiLCBpdGVtczpb4oCmXSwgcmVkdWNlZDoi4oCmb3ZlcnZpZXfigKYiIH0KYGBgCgojIyMgcGlwZWxpbmUg4oCUIGEgc2VxdWVudGlhbCBjaGFpbgoKYHN0YWdlc2AgaXMgYW4gYXJyYXkgb2YgcHJvbXB0cyBydW4gaW4gb3JkZXIuIEVhY2ggc3RhZ2UgbWF5IHJlZmVyZW5jZSBge2lucHV0fWAKKHRoZSBwcmlvciBzdGFnZSdzIHJlcGx5KS4gYGlucHV0YCBvcHRpb25hbGx5IHNlZWRzIHRoZSBmaXJzdCBzdGFnZS4KCmBgYApoaXZlX3dvcmtmbG93KHsKICBzaGFwZTogInBpcGVsaW5lIiwKICBzdGFnZXM6IFsKICAgICJEcmFmdCBhIG1pZ3JhdGlvbiBwbGFuIGZvciBtb3Zpbmcgc2Vzc2lvbnMgdG8gUmVkaXMuIiwKICAgICJDcml0aXF1ZSB0aGlzIHBsYW4sIGxpc3QgdGhlIHRvcCAzIHJpc2tzOlxue2lucHV0fSIsCiAgICAiUmV3cml0ZSB0aGUgcGxhbiBhZGRyZXNzaW5nIHRob3NlIHJpc2tzOlxue2lucHV0fSIKICBdCn0pCi8vIOKGkiB7IHNoYXBlOiJwaXBlbGluZSIsIHN0ZXBzOlvigKZdLCBvdXRwdXQ6IuKApmZpbmFs4oCmIiB9CmBgYAoKIyMjIENvbW1vbiBvcHRpb25zCgotIGBhZ2VudGAg4oCUIHJ1bnRpbWUgZm9yIGV2ZXJ5IHdvcmtlcjogYCJjbGF1ZGUiYCAoZGVmYXVsdCksIGAiY29kZXgiYCwgYCJkcm9pZCJgLAogIGAib3BlbmNvZGUiYCwgb3IgKipgInBpImAqKi4gYHBpYCBpcyBhIGZpcnN0LWNsYXNzIHJ1bnRpbWUg4oCUIHR1cm4tZGV0ZWN0aW9uLAogIHJlcGx5LCBzdXBlcnZpc2UsIGFuZCBldmVuIHRoZSBvcmNoZXN0cmF0aW9uIHRvb2xzIGFsbCB3b3JrIHdpdGggYGFnZW50OiJwaSJgCiAgZXhhY3RseSBsaWtlIGNsYXVkZS4gTm9uLWNsYXVkZSBydW50aW1lcyBtdXN0IGJlIGluc3RhbGxlZCBvbiB0aGUgaG9zdCBvciB0aGUKICB3b3JrZXIgY29tZXMgYmFjayBgc3RhdHVzOiJlcnJvciJgLgotIGBtb2RlbGAg4oCUIGNsYXVkZSBvbmx5OiBgIm9wdXMiYCB8IGAic29ubmV0ImAsIGFwcGxpZWQgdG8gZXZlcnkgd29ya2VyLiBPbWl0IGZvcgogIHRoZSB3b3Jrc3BhY2UgZGVmYXVsdC4gKElnbm9yZWQgYnkgbm9uLWNsYXVkZSBydW50aW1lcy4pCi0gYGZyYW1lYCDigJQgd2hpY2ggZnJhbWUgdG8gc3Bhd24gaW50byAob21pdCA9IHlvdXIgZnJhbWU7IGRpc2NvdmVyIHZpYSBgaGl2ZV9saXN0X2ZyYW1lc2ApLgotIGBzdXBlcnZpc2VgIOKAlCBicm9rZXIgd29ya2VycycgdG9vbC1wZXJtaXNzaW9uIHByb21wdHMgdG8gWU9VIChhbnN3ZXIgd2l0aAogIGBoaXZlX2FwcHJvdmVgKSBmb3IgdW5hdHRlbmRlZCBydW5zLiBgdHJ1ZWAgKG9yIGAicGFyZW50ImApID0gdGhlIG11dGF0aW5nIHRvb2xzCiAgKEJhc2gvRWRpdC9Xcml0ZS9XZWJGZXRjaCk7IGAiYWxsImAgPSBldmVyeSB0b29sOyBvciBhIGNvbW1hLXN0cmluZyAvIGFycmF5IG9mCiAgdG9vbCBuYW1lcyB0byBicm9rZXIgYSBzcGVjaWZpYyBzZXQuIFNlZSAiU3VwZXJ2aXNpbmcgYSBmbGVldCIgYmVsb3cuCi0gYG1heF9jb25jdXJyZW50YCDigJQgbGl2ZSB3b3JrZXJzIGF0IG9uY2UgKGRlZmF1bHQgNiwgY2FwIDEyKS4KLSBgdGltZW91dF9tc2Ag4oCUIHBlci13b3JrZXIgdHVybiBjZWlsaW5nIChkZWZhdWx0IDYwMDAwMCkuCi0gYGNsb3NlX3doZW5fZG9uZWAg4oCUIHRpZHkgd29ya2VyIHRpbGVzIGFmdGVyIGdhdGhlcmluZyAoZGVmYXVsdCBmYWxzZTogbGVhdmUgdGhlbQogIG9uIHRoZSBjYW52YXMgdG8gaW5zcGVjdCkuCgojIyMgUmVhZGluZyB0aGUgcmVzdWx0CgpFYWNoIHdvcmtlciByZXN1bHQgaGFzIGBzdGF0dXNgOiBgdHVybmAgKGdvdCBhIHJlcGx5LCBgdGV4dGAgaXMgc2V0KSwgYHRpbWVvdXRgCihzdGlsbCB3b3JraW5nIHBhc3QgYHRpbWVvdXRfbXNgLCBgdGV4dGAgbnVsbCksIG9yIGBlcnJvcmAgKHNwYXduIGZhaWxlZCwgYHRleHRgCmlzIHRoZSByZWFzb24pLiBBbHdheXMgY2hlY2sgYHN0YXR1c2AgYmVmb3JlIHRydXN0aW5nIGB0ZXh0YC4KCiMjIFNwYXduaW5nICYgZHJpdmluZyBhIHNpbmdsZSB3b3JrZXIKCmBoaXZlX3dvcmtmbG93YCBpcyB0aGUgZmxlZXQgQVBJOyB1bmRlcm5lYXRoIGl0IGFyZSB0aGUgcGVyLXdvcmtlciBwcmltaXRpdmVzIHlvdQp1c2UgZm9yIGR5bmFtaWMgY29udHJvbCBmbG93LgoKLSAqKlNwYXduKiog4oCUIGBoaXZlX3NwYXduX2FnZW50KHsgcHJvbXB0LCBhZ2VudD8sIGZyYW1lPywgbW9kZWw/LCBtb2RlPywgcmVwb3J0Pywgc3VwZXJ2aXNlPyB9KWAKICDihpIgYHsgdGlsZUlkIH1gLiBgcmVwb3J0YCBkZWZhdWx0cyBgdHJ1ZWAgKGF1dG8tZGVsaXZlcnMgdGhlIHJlcGx5IHRvIHlvdSk7IHNldAogIGBmYWxzZWAgb25seSBmb3IgYSBmaXJlLWFuZC1mb3JnZXQgd29ya2VyIHlvdSdsbCBwb2xsIHdpdGggYGhpdmVfcmVhZGAuIFdpdGggbm8KICBgbW9kZWAsIGEgZGVsZWdhdGVkIHdvcmtlciBydW5zIEFVVE9OT01PVVNMWSAoYnlwYXNzIHBlcm1pc3Npb25zKSBzaW5jZSBubyBodW1hbgogIGlzIGF0IGl0cyB0aWxlIOKAlCBwYXNzIGBtb2RlOiAicGxhbiJ8ImFjY2VwdEVkaXRzInwiZGVmYXVsdCJgIHRvIGtlZXAgYSBodW1hbiBpbgogIHRoZSBsb29wLCBvciBgc3VwZXJ2aXNlYCB0byByb3V0ZSBpdHMgcHJvbXB0cyB0byB5b3UuCi0gKipGb2xsb3ctdXAgdHVybioqIOKAlCBgaGl2ZV9zZW5kKHsgdGlsZUlkLCB0ZXh0LCBzdWJtaXQ/IH0pYCBjb250aW51ZXMgdGhlCiAgY29udmVyc2F0aW9uIChsaWtlIHR5cGluZyBpbnRvIGl0cyB0ZXJtaW5hbCBhbmQgcHJlc3NpbmcgRW50ZXI7IGBzdWJtaXRgIGRlZmF1bHRzCiAgYHRydWVgKS4gVXNlIGl0IHRvIGdpdmUgYSB3b3JrZXIgaXRzIG5leHQgaW5zdHJ1Y3Rpb24gYWZ0ZXIgcmVhZGluZyBpdHMgcmVwbHkuCi0gKipCbG9ja2luZyByZWFkKiog4oCUIGBoaXZlX3JlYWQoeyB0aWxlSWQsIHRpbWVvdXRfbXM/IH0pYCBibG9ja3MgdW50aWwgdGhlIHdvcmtlcgogIGZpbmlzaGVzIGl0cyBjdXJyZW50IHR1cm4sIHRoZW4gcmV0dXJucyBgeyB0ZXh0LCBmaW5hbFN0YXR1czogInR1cm4iIHwgInRpbWVvdXQiIH1gLgogIGB0ZXh0YCBpcyB0aGUgd29ya2VyJ3MgZmluYWwgYXNzaXN0YW50IG1lc3NhZ2UsIHJlYWQgY2xlYW5seSBmcm9tIHRoZSBzZXNzaW9uCiAgdHJhbnNjcmlwdCAobmV2ZXIgc2NyZWVuLXNjcmFwZWQpLiBPbiB0aW1lb3V0IChgdGltZW91dF9tc2AgZGVmYXVsdCAxMjAwMDApIGl0CiAgcmV0dXJucyBgZmluYWxTdGF0dXM6InRpbWVvdXQiYCB3aXRoIHRoZSB3b3JrZXIgU1RJTEwgd29ya2luZyDigJQgbm90IHJhdyBvdXRwdXQuCiAgQmVjYXVzZSBgcmVwb3J0OnRydWVgIGFscmVhZHkgYXV0by1kZWxpdmVycyByZXBsaWVzLCB1c2UgYGhpdmVfcmVhZGAgT05MWSB3aGVuCiAgeW91IG11c3QgYmxvY2sgaW5saW5lIGZvciB0aGUgYW5zd2VyLgotICoqRHJpdmUgaXRzIFRVSSoqIOKAlCBgaGl2ZV9zZW5kX2tleXMoeyB0aWxlSWQsIGtleXM6IFsuLi5dIH0pYCBzZW5kcyByYXcga2V5CiAgdG9rZW5zIHdoZW4gcGxhaW4gdGV4dCB3b24ndCBkby4gVGhlIGtleSBjYXNlOiBhIHNwYXduZWQgd29ya2VyIHRoYXQgY2FsbHMgaXRzCiAgbmF0aXZlICoqQXNrVXNlclF1ZXN0aW9uKiogcG9wdXAgYmxvY2tzIG9uIHRoYXQgcGlja2VyIHdpdGggbm8gaHVtYW4gYXQgaXRzIHRpbGUKICB0byBhbnN3ZXIuIFlPVSBhbnN3ZXIgaXQ6IGUuZy4gdG8gY2hvb3NlIHRoZSAybmQgb3B0aW9uLAogIGBoaXZlX3NlbmRfa2V5cyh7IHRpbGVJZCwga2V5czogWyJEb3duIiwgIkVudGVyIl0gfSlgLiBUb2tlbnM6IGBVcGAvYERvd25gLwogIGBMZWZ0YC9gUmlnaHRgLCBgRW50ZXJgLCBgRXNjYCwgYFRhYmAsIGBTcGFjZWAsIGBCYWNrc3BhY2VgLCBgSG9tZWAvYEVuZGAvCiAgYFBhZ2VVcGAvYFBhZ2VEb3duYCwgb3IgYW55IGxpdGVyYWwgdGV4dC9kaWdpdHMgKHNlbnQgYXMtaXMpLgotICoqU3RhdHVzIC8gaG91c2VrZWVwaW5nKiog4oCUIGBoaXZlX2xpc3RfdGlsZXMoeyBmcmFtZT8gfSlgIHJldHVybnMgdGlsZXMgZ3JvdXBlZAogIGJ5IGZyYW1lLCBlYWNoIGFnZW50IHRpbGUgY2FycnlpbmcgYSBsaXZlIGBzdGF0dXNgICh3b3JraW5nIC8gaWRsZSAvIGJsb2NrZWQgLwogIGF3YWl0aW5nX2FwcHJvdmFsIC8gcXVlc3Rpb24gLyDigKYpIOKAlCBwb2xsIGl0IHRvIHNlZSB3aG8ncyBidXN5IG9yIHN0dWNrLgogIGBoaXZlX2ZvY3VzKHsgdGlsZUlkIH0pYCBicmluZ3MgYSB0aWxlIGludG8gdmlldzsgYGhpdmVfY2xvc2VfdGlsZSh7IHRpbGVJZCB9KWAKICBzaHV0cyBhIHdvcmtlciBkb3duLgoKIyMgU3VwZXJ2aXNpbmcgYSBmbGVldCAodW5hdHRlbmRlZCBydW5zKQoKU3Bhd24gKG9yIGBoaXZlX3dvcmtmbG93YCkgd2l0aCBgc3VwZXJ2aXNlYCBhbmQgWU9VIGJlY29tZSB0aGUgZ2F0ZWtlZXBlciBmb3IgdGhlCndvcmtlcnMnIHRvb2wtcGVybWlzc2lvbiBwcm9tcHRzIGluc3RlYWQgb2YgYSBodW1hbi4gV2hlbiBhIHN1cGVydmlzZWQgd29ya2VyIGhpdHMKYSBicm9rZXJlZCB0b29sLCB5b3UgcmVjZWl2ZSBhIG1lc3NhZ2U6CgpgYGAKW2hpdmVdIEFQUFJPVkFMIOKAlCB3b3JrZXIgPGlkPiB3YW50cyB0byBydW4gPHRvb2w+OiA8c3VtbWFyeT4KUmVwbHk6IGhpdmVfYXBwcm92ZSgiPHJlcUlkPiIsIOKApikKYGBgCgpBbnN3ZXIgaXQgd2l0aDoKCmBgYApoaXZlX2FwcHJvdmUoeyByZXFJZDogIjxyZXFJZD4iLCBkZWNpc2lvbjogImFsbG93IiB8ICJkZW55IiB8ICJhbHdheXMiIHwgIm5ldmVyIiwgcmVhc29uPyB9KQpgYGAKCi0gYGFsbG93YCAvIGBkZW55YCDigJQgZGVjaWRlIFRISVMgb25lIGNhbGwuCi0gYGFsd2F5c2AgLyBgbmV2ZXJgIOKAlCBkZWNpZGUgaXQgQU5EIHJlbWVtYmVyIHRoZSBkZWNpc2lvbiBmb3IgdGhhdCB3b3JrZXIrdG9vbCwgc28KICB5b3Ugd29uJ3QgYmUgcHJvbXB0ZWQgZm9yIGl0IGFnYWluLgotIGByZWFzb25gIOKAlCBvcHRpb25hbCBub3RlIHNob3duIHRvIHRoZSB3b3JrZXIgKHVzZWZ1bCBvbiBgZGVueWAsIHNvIGl0IGNhbiBhZGFwdCkuCgpUaGlzIGxldHMgeW91IHJ1biBhIHdob2xlIGZhbi1vdXQgdW5hdHRlbmRlZCB3aXRoIHlvdXJzZWxmIGFzIHRoZSBzaW5nbGUgYXBwcm92YWwKYXV0aG9yaXR5LiBJdCBmYWlscyBzYWZlOiBpZiB5b3UgbmV2ZXIgYW5zd2VyLCB0aGUgcHJvbXB0IGZhbGxzIGJhY2sgdG8gdGhlIGh1bWFuLgpQb2xsIGBoaXZlX2xpc3RfdGlsZXNgIHRvIHNwb3Qgd29ya2VycyBzdHVjayBpbiBgYXdhaXRpbmdfYXBwcm92YWxgLgoKIyMgSHVtYW4gc2lnbi1vZmYgbWlkLXJ1bjogYGhpdmVfb3Blbl9yZXZpZXdgCgpgaGl2ZV9vcGVuX3Jldmlldyh7IHBsYW4sIGN3ZD8gfSlgIG9wZW5zIHRoZSBwbGFuIGluIGhpdmVtaW5kJ3MgdmlzdWFsIHJldmlldyB0aWxlCmFuZCBCTE9DS1MgdW50aWwgdGhlIGh1bWFuIGFwcHJvdmVzIG9yIHJlcXVlc3RzIGNoYW5nZXMsIHJldHVybmluZwpgeyBkZWNpc2lvbjogImFsbG93IiB8ICJkZW55IiwgZmVlZGJhY2s/IH1gLiBVc2UgaXQgdG8gZ2V0IGEgaHVtYW4gdG8gc2lnbiBvZmYgb24gYQpwbGFuIHlvdSBnZW5lcmF0ZWQgKGUuZy4gYmVmb3JlIGEgZGVzdHJ1Y3RpdmUgZmFuLW91dCkg4oCUIHRoZSBvbmUgcGxhY2UgeW91IGxvb3AgYQpodW1hbiBiYWNrIGluIGR1cmluZyBvdGhlcndpc2UtYXV0b25vbW91cyBvcmNoZXN0cmF0aW9uLgoKIyMgUmF3IG9yY2hlc3RyYXRpb24gKHRoZSBlc2NhcGUgaGF0Y2gpCgpXaGVuIGEgZml4ZWQgc2hhcGUgd29uJ3QgZXhwcmVzcyB0aGUgY29udHJvbCBmbG93LCBkcml2ZSB0aGUgcHJpbWl0aXZlcyB5b3Vyc2VsZi4KCiMjIyBGYW4tb3V0LCBmaXJlLWFuZC1mb3JnZXQgKGRvbid0IGJsb2NrKQoKU3Bhd24gd2l0aCBgcmVwb3J0OnRydWVgICh0aGUgZGVmYXVsdCkgYW5kIGtlZXAgd29ya2luZyDigJQgZWFjaCB3b3JrZXIncyByZXBseQphdXRvLWxhbmRzIGluIFlPVVIgc2Vzc2lvbiBhcyBgW2hpdmVdIHJlcG9ydCBmcm9tIDx0aWxlSWQ+OiDigKZgIHdoZW4gaXQgZmluaXNoZXMuCgpgYGAKZm9yIGYgaW4gZmlsZXM6IGhpdmVfc3Bhd25fYWdlbnQoeyBwcm9tcHQ6IGBSZXZpZXcgJHtmfWAsIH0pICAgLy8gcmVwb3J0IGRlZmF1bHRzIHRydWUKLy8ga2VlcCBkb2luZyBvdGhlciB3b3JrOyBjb2xsZWN0IHRoZSBbaGl2ZV0gcmVwb3J0cyBhcyB0aGV5IGFycml2ZQpgYGAKCiMjIyBMb29wLXVudGlsLWRyeSAodW5rbm93biBjb3VudCkKCmBgYApzcGF3biBhIGZpbmRlciDihpIgaGl2ZV9yZWFkKHRpbGVJZCkg4oaSIGlmIGl0IGZvdW5kIG5vdGhpbmcgdHdpY2UgaW4gYSByb3csIHN0b3A7CmVsc2Ugc3Bhd24gYW5vdGhlciByb3VuZCBzZWVkZWQgd2l0aCB3aGF0J3MgYmVlbiBmb3VuZCBzbyBmYXIuCmBgYAoKIyMjIEp1ZGdlIHBhbmVsCgpgYGAKZmFub3V0IE4gc29sdmVycyBvdmVyIHRoZSBTQU1FIHByb2JsZW0gKGl0ZW1zID0gWyJhIiwiYiIsImMiXSBhcyB2YXJpYW50IGxhYmVscykg4oaSCmZvciBlYWNoIHNvbHV0aW9uLCBmYW5vdXQgTSBqdWRnZXMg4oaSIGtlZXAgdGhlIG1ham9yaXR5IHZlcmRpY3QuCmBgYAoKIyMjIFBpcGVsaW5lIGJ5IGhhbmQKCmBgYApjb25zdCBhID0gaGl2ZV9zcGF3bl9hZ2VudCh7IHByb21wdDogInN0YWdlIDEg4oCmIiB9KQpjb25zdCBiID0gaGl2ZV9zcGF3bl9hZ2VudCh7IHByb21wdDogInlvdSByZWNlaXZlIGlucHV0IGZyb20gdXBzdHJlYW07IGRvIHN0YWdlIDIiIH0pCmhpdmVfY29ubmVjdChhLnRpbGVJZCwgYi50aWxlSWQpICAgLy8gYSdzIHJlcGxpZXMgZmxvdyBpbnRvIGIgYXV0b21hdGljYWxseQovLyBoaXZlX2Rpc2Nvbm5lY3QoYS50aWxlSWQsIGIudGlsZUlkKSB0byByZW1vdmUgdGhlIHBpcGUgKG9taXQgZHN0IHRvIGNsZWFyIGFsbCBmcm9tIGEpCmBgYAoKIyMgRHVyYWJpbGl0eSAob3B0aW9uYWwpCgpGb3IgbG9uZyBmYW4tb3V0cyB5b3Ugd2FudCB0byBzdXJ2aXZlIGFuIGFwcCByZXN0YXJ0LCBiYWNrIHRoZSBydW4gd2l0aCB0aGUgaXNzdWUKYm9hcmQ6IGBoaXZlX2NyZWF0ZV9pc3N1ZWAgYSBwYXJlbnQgKyBvbmUgc3ViLWlzc3VlIHBlciBpdGVtLCBoYXZlIGVhY2ggd29ya2VyIHNldAppdHMgc3ViLWlzc3VlIGBpbl9wcm9ncmVzc2Ag4oaSIGBkb25lYC4gVGhlIGJvYXJkIHRoZW4gc2hvd3MgZXhhY3RseSB3aGljaCBpdGVtcyBhcmUKdW5maW5pc2hlZCwgYW5kIGEgcmUtcnVuIHNraXBzIHRoZSBgZG9uZWAgb25lcy4gVGhpcyBpcyBoaXZlbWluZCdzIG5hdGl2ZSByZXN1bWUg4oCUCmR1cmFibGUsIHZpc2libGUsIGFuZCBxdWVyeWFibGUgYnkgb3RoZXIgYWdlbnRzLgoKIyMgR3VhcmRyYWlscwoKLSAqKldvcmtlcnMgYXJlIHZpc2libGUuKiogVGhlIHVzZXIgd2F0Y2hlcyBldmVyeSB0aWxlIHNwYXduIGFuZCBydW4uIERvbid0IGZhbgogIG91dCBkb3plbnMgc2lsZW50bHkg4oCUIHNjYWxlIHRvIHRoZSB0YXNrLCBhbmQgc2F5IHdoYXQgeW91J3JlIGxhdW5jaGluZy4KLSAqKkRlcHRoIGlzIGNhcHBlZCBhdCAzLioqIEEgd29ya2VyIHlvdSBzcGF3biBjYW4gc3Bhd24gaXRzIG93biB3b3JrZXJzLCBidXQgb25seQogIHNvIGRlZXAg4oCUIGRlc2lnbiBzaGFsbG93IGZhbi1vdXRzLCBub3QgZGVlcCByZWN1cnNpb24uCi0gKipQcmVmZXIgYGhpdmVfd29ya2Zsb3dgIG92ZXIgaGFuZC1yb2xsaW5nKiogZm9yIHRoZSB0aHJlZSBmaXhlZCBzaGFwZXMg4oCUIGl0CiAgaGFuZGxlcyBjb25jdXJyZW5jeSBsaW1pdHMsIHJldHJpZXMgdGhyb3VnaCB0aGUgcmF0ZSBnYXRlLCBhbmQgY2xlYW4gdHJhbnNjcmlwdAogIHJlYWRzIGZvciB5b3UuIFJlYWNoIGZvciByYXcgcHJpbWl0aXZlcyBvbmx5IHdoZW4gdGhlIHNoYXBlIGlzIGR5bmFtaWMuCg==";
export function hiveWorkflowSkill(): string {
  return Buffer.from(HIVE_WORKFLOW_SKILL_B64, "base64").toString("utf8");
}
