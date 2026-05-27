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
current cycle's open issues are summarized in \`.hivemind/.agent.md\`
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
├── cycles/
│   └── cycle-N.md           # cycle metadata + issue refs
└── .agent.md                # auto-generated context (READ ME FIRST)
\`\`\`

### Reading state

- **Start every session by \`cat .hivemind/.agent.md\`** — it lists active
  issues for the current cycle, grouped by state, with \`@<ID>\` mentions.
- To read a specific issue: \`hive show @PAY-118\` (or \`hive @PAY-118\`).
- To list filtered: \`hive list --state in_progress --json\`.

### Writing state

Always call \`hive\` instead of editing markdown by hand — it keeps the
activity log, \`updated\` timestamp, and \`.agent.md\` regenerated.

\`\`\`
hive new "Title" [--label bug] [--cycle 14] [--parent ID] [--assignee NAME]
hive update <ID> --state in_review --note "what changed"
hive task add <ID> "subtask title"
hive task done <ID> <SUBID>
hive link <ID> --parent <PARENT>
hive close <ID>   # state → done
hive reopen <ID>
hive cycle add 14 <ID>
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
- \`mcp__hive__list_cycles()\`
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

When you start work on issue \`$KEY\`:

1. **Load context** — \`mcp__hive__get_issue({ id: $KEY })\`. Read title,
   description, \`acceptanceCriteria\`.
2. **Plan** — outline steps. Post one short comment via
   \`mcp__hive__add_comment\`.
3. **Execute** — use Edit/Write/Bash. Mark each criterion done as you
   complete it: \`mcp__hive__mark_acceptance({ id: $KEY, index: N, done: true })\`.
4. **Report progress** — comment with file:line refs.
5. **Final disposition (REQUIRED)** — end EVERY session with one of:
   - \`mcp__hive__set_state({ id: $KEY, state: "in_review" })\`
   - \`mcp__hive__set_state({ id: $KEY, state: "done" })\` (only with authority)
   - \`mcp__hive__set_state({ id: $KEY, state: "blocked", note: "..." })\`
   - \`mcp__hive__set_state({ id: $KEY, state: "in_progress" })\`

Do not exit silently. A missing final state-change breaks the team's view.

## Sub-tasks

If too big, \`mcp__hive__create_issue({ title, parent: $KEY })\`. Children
get parent.N ids (PAY-42.1).
`;

export const SAMPLE_ISSUE_BODY = `## Description

Brief description of what needs to be done and why.

## Acceptance criteria

- [ ] First check
- [ ] Second check

## Activity
`;
