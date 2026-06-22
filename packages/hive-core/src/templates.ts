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
  "LS0tCm5hbWU6IGhpdmUtd29ya2Zsb3cKZGVzY3JpcHRpb246IFVzZSB3aGVuIHlvdSAoYW4gYWdlbnQgcnVubmluZyBpbiBhIGhpdmVtaW5kIHRpbGUpIG5lZWQgdG8gcnVuIGEgTVVMVEktQUdFTlQgd29ya2Zsb3cg4oCUIGZhbiBhIHRhc2sgb3V0IHRvIHNldmVyYWwgd29ya2VyIGFnZW50cyBpbiBwYXJhbGxlbCwgY2hhaW4gYWdlbnRzIGludG8gYSBwaXBlbGluZSwgbWFwLXJlZHVjZSBvdmVyIGEgbGlzdCwgb3Igb3RoZXJ3aXNlIG9yY2hlc3RyYXRlIGEgZmxlZXQgb2Ygc2libGluZyBhZ2VudHMgb24gdGhlIGNhbnZhcy4gVHJpZ2dlcnMgb24gImZhbiBvdXQiLCAicnVuIE4gYWdlbnRzIiwgImluIHBhcmFsbGVsIiwgIm9yY2hlc3RyYXRlIiwgInNwYXduIHdvcmtlcnMiLCAic3BsaXQgdGhpcyBhY3Jvc3MgYWdlbnRzIiwgInJldmlldyBhbGwgdGhlc2UgZmlsZXMiLCAibWFwLXJlZHVjZSIsIG9yIHdoZW4gYW4gaXNzdWUgaXMgdG9vIGJpZyBmb3Igb25lIGFnZW50IGFuZCBuYXR1cmFsbHkgZGVjb21wb3NlcyBpbnRvIGluZGVwZW5kZW50IHVuaXRzLiBQcmVmZXIgdGhlIGBtY3BfX2hpdmVfX2hpdmVfd29ya2Zsb3dgIHRvb2wgZm9yIGZpeGVkIHNoYXBlczsgZHJvcCB0byByYXcgc3Bhd24vcmVhZC9jb25uZWN0IG9ubHkgZm9yIGR5bmFtaWMgY29udHJvbCBmbG93LgotLS0KCiMgTXVsdGktYWdlbnQgd29ya2Zsb3dzIG9uIHRoZSBoaXZlbWluZCBjYW52YXMKCllvdSBhcmUgYW4gYWdlbnQgaW4gYSBoaXZlbWluZCB0aWxlLiBZb3UgY2FuIHNwYXduICoqc2libGluZyBhZ2VudHMgYXMgdmlzaWJsZQp0aWxlcyoqIGFuZCBvcmNoZXN0cmF0ZSB0aGVtLiBXb3JrZXJzIGFyZSByZWFsIHRpbGVzIHRoZSB1c2VyIHdhdGNoZXMg4oCUIGNoaWxkcmVuCm9mIHlvdSwgZGVwdGgtY2FwcGVkIChtYXggMyBkZWVwKSBhbmQgcmF0ZS1saW1pdGVkLiBUd28gbGF5ZXJzOgoKMS4gKipgbWNwX19oaXZlX19oaXZlX3dvcmtmbG93YCoqIOKAlCBvbmUgYmxvY2tpbmcgY2FsbCBmb3IgdGhlIGNvbW1vbiBzaGFwZXMuIFVzZQogICB0aGlzIGZpcnN0LiBJdCBzcGF3bnMgdGhlIGZsZWV0LCBkcml2ZXMgaXQsIGFuZCByZXR1cm5zIGFnZ3JlZ2F0ZWQgcmVwbGllcy4KMi4gKipSYXcgYG1jcF9faGl2ZV9fKmAqKiAoYGhpdmVfc3Bhd25fYWdlbnRgIC8gYGhpdmVfcmVhZGAgLyBgaGl2ZV9jb25uZWN0YCAvCiAgIGBoaXZlX3JlcG9ydGApIOKAlCB3aGVuIGNvbnRyb2wgZmxvdyBpcyBkeW5hbWljIGFuZCBubyBmaXhlZCBzaGFwZSBmaXRzLgoKPiBBbGwgb2YgdGhlc2Ugbm8tb3Agd2l0aCAiYXBwIG5vdCBydW5uaW5nIiBpZiBoaXZlbWluZCBpc24ndCB1cCDigJQgc2FmZSB0byB0cnkuCgojIyBXaGVuIHRvIHVzZSB3aGljaAoKfCBZb3UgbmVlZOKApiB8IFVzZSB8CnwtLS18LS0tfAp8IFNhbWUgdGFzayBvdmVyIGEgbGlzdCwgaW4gcGFyYWxsZWwgfCBgaGl2ZV93b3JrZmxvdyh7IHNoYXBlOiAiZmFub3V0IiB9KWAgfAp8IEZhbiBvdXQgKyBzeW50aGVzaXplIHRoZSByZXN1bHRzIHwgYGhpdmVfd29ya2Zsb3coeyBzaGFwZTogIm1hcHJlZHVjZSIgfSlgIHwKfCBBIOKGkiBCIOKGkiBDLCBlYWNoIGNvbnN1bWluZyB0aGUgbGFzdCB8IGBoaXZlX3dvcmtmbG93KHsgc2hhcGU6ICJwaXBlbGluZSIgfSlgIHwKfCBMb29wIHVudGlsIGEgY29uZGl0aW9uIC8gdW5rbm93biBjb3VudCB8IHJhdyBzcGF3biArIGBoaXZlX3JlYWRgIGxvb3AgfAp8IEEganVkZ2UgcGFuZWwsIHZvdGluZywgY29uZGl0aW9uYWwgYnJhbmNoZXMgfCByYXcgc3Bhd24gKyBgaGl2ZV9yZWFkYCB8CgojIyBUaGUgdG9vbDogYGhpdmVfd29ya2Zsb3dgCgojIyMgZmFub3V0IOKAlCBOIHdvcmtlcnMgaW4gcGFyYWxsZWwKCk9uZSB3b3JrZXIgcGVyIGBpdGVtc1tpXWAuIGBwcm9tcHRgIGlzIGEgdGVtcGxhdGU7IGB7aXRlbX1gIGlzIGZpbGxlZCBwZXIgd29ya2VyLgpCbG9ja3MgdW50aWwgYWxsIGZpbmlzaCwgcmV0dXJucyBlYWNoIHJlcGx5LgoKYGBgCmhpdmVfd29ya2Zsb3coewogIHNoYXBlOiAiZmFub3V0IiwKICBpdGVtczogWyJzcmMvYXV0aC50cyIsICJzcmMvcGF5LnRzIiwgInNyYy9hcGkudHMiXSwKICBwcm9tcHQ6ICJSZXZpZXcge2l0ZW19IGZvciBzZWN1cml0eSBidWdzLiBMaXN0IGZpbmRpbmdzIGFzIGZpbGU6bGluZSDigJQgb25lIGxpbmUgZWFjaC4iLAogIG1heF9jb25jdXJyZW50OiA2Cn0pCi8vIOKGkiB7IHNoYXBlOiJmYW5vdXQiLCBpdGVtczpbIHtpdGVtLCB0aWxlSWQsIHN0YXR1czoidHVybiJ8InRpbWVvdXQifCJlcnJvciIsIHRleHR9LCDigKYgXSB9CmBgYAoKIyMjIG1hcHJlZHVjZSDigJQgZmFub3V0LCB0aGVuIG9uZSByZWR1Y2VyCgpSdW5zIHRoZSBmYW5vdXQsIHRoZW4gc3Bhd25zIE9ORSByZWR1Y2VyIGFnZW50IGZlZCBldmVyeSB3b3JrZXIncyBvdXRwdXQgdmlhCmByZWR1Y2VfcHJvbXB0YCAoYHtyZXN1bHRzfWAgPSBhbGwgb3V0cHV0cyBqb2luZWQpLgoKYGBgCmhpdmVfd29ya2Zsb3coewogIHNoYXBlOiAibWFwcmVkdWNlIiwKICBpdGVtczogWyJhdXRoIiwgImJpbGxpbmciLCAic2VhcmNoIl0sCiAgcHJvbXB0OiAiU3VtbWFyaXplIHRoZSB7aXRlbX0gbW9kdWxlIGluIDMgYnVsbGV0cy4iLAogIHJlZHVjZV9wcm9tcHQ6ICJIZXJlIGFyZSBtb2R1bGUgc3VtbWFyaWVzOlxue3Jlc3VsdHN9XG5cbldyaXRlIGEgb25lLXBhcmFncmFwaCBhcmNoaXRlY3R1cmUgb3ZlcnZpZXcuIgp9KQovLyDihpIgeyBzaGFwZToibWFwcmVkdWNlIiwgaXRlbXM6W+KApl0sIHJlZHVjZWQ6IuKApm92ZXJ2aWV34oCmIiB9CmBgYAoKIyMjIHBpcGVsaW5lIOKAlCBhIHNlcXVlbnRpYWwgY2hhaW4KCmBzdGFnZXNgIGlzIGFuIGFycmF5IG9mIHByb21wdHMgcnVuIGluIG9yZGVyLiBFYWNoIHN0YWdlIG1heSByZWZlcmVuY2UgYHtpbnB1dH1gCih0aGUgcHJpb3Igc3RhZ2UncyByZXBseSkuIGBpbnB1dGAgb3B0aW9uYWxseSBzZWVkcyB0aGUgZmlyc3Qgc3RhZ2UuCgpgYGAKaGl2ZV93b3JrZmxvdyh7CiAgc2hhcGU6ICJwaXBlbGluZSIsCiAgc3RhZ2VzOiBbCiAgICAiRHJhZnQgYSBtaWdyYXRpb24gcGxhbiBmb3IgbW92aW5nIHNlc3Npb25zIHRvIFJlZGlzLiIsCiAgICAiQ3JpdGlxdWUgdGhpcyBwbGFuLCBsaXN0IHRoZSB0b3AgMyByaXNrczpcbntpbnB1dH0iLAogICAgIlJld3JpdGUgdGhlIHBsYW4gYWRkcmVzc2luZyB0aG9zZSByaXNrczpcbntpbnB1dH0iCiAgXQp9KQovLyDihpIgeyBzaGFwZToicGlwZWxpbmUiLCBzdGVwczpb4oCmXSwgb3V0cHV0OiLigKZmaW5hbOKApiIgfQpgYGAKCiMjIyBDb21tb24gb3B0aW9ucwoKLSBgYWdlbnRgIOKAlCBydW50aW1lIGZvciB3b3JrZXJzIChgY2xhdWRlYCBkZWZhdWx0LCBgY29kZXhgLCBgZHJvaWRgLCDigKYpLgotIGBmcmFtZWAg4oCUIHdoaWNoIGZyYW1lIHRvIHNwYXduIGludG8gKG9taXQgPSB5b3VyIGZyYW1lOyBkaXNjb3ZlciB2aWEgYGhpdmVfbGlzdF9mcmFtZXNgKS4KLSBgc3VwZXJ2aXNlYCDigJQgYnJva2VyIHdvcmtlcnMnIHRvb2wtcGVybWlzc2lvbiBwcm9tcHRzIHRvIFlPVSAoYW5zd2VyIHdpdGgKICBgaGl2ZV9hcHByb3ZlYCkgZm9yIHVuYXR0ZW5kZWQgcnVucy4gYHRydWVgID0gbXV0YXRpbmcgdG9vbHM7IGAiYWxsImAgPSBldmVyeXRoaW5nLgotIGBtYXhfY29uY3VycmVudGAg4oCUIGxpdmUgd29ya2VycyBhdCBvbmNlIChkZWZhdWx0IDYsIGNhcCAxMikuCi0gYHRpbWVvdXRfbXNgIOKAlCBwZXItd29ya2VyIHR1cm4gY2VpbGluZyAoZGVmYXVsdCA2MDAwMDApLgotIGBjbG9zZV93aGVuX2RvbmVgIOKAlCB0aWR5IHdvcmtlciB0aWxlcyBhZnRlciBnYXRoZXJpbmcgKGRlZmF1bHQgZmFsc2U6IGxlYXZlIHRoZW0KICBvbiB0aGUgY2FudmFzIHRvIGluc3BlY3QpLgoKIyMjIFJlYWRpbmcgdGhlIHJlc3VsdAoKRWFjaCB3b3JrZXIgcmVzdWx0IGhhcyBgc3RhdHVzYDogYHR1cm5gIChnb3QgYSByZXBseSwgYHRleHRgIGlzIHNldCksIGB0aW1lb3V0YAooc3RpbGwgd29ya2luZyBwYXN0IGB0aW1lb3V0X21zYCwgYHRleHRgIG51bGwpLCBvciBgZXJyb3JgIChzcGF3biBmYWlsZWQsIGB0ZXh0YAppcyB0aGUgcmVhc29uKS4gQWx3YXlzIGNoZWNrIGBzdGF0dXNgIGJlZm9yZSB0cnVzdGluZyBgdGV4dGAuCgojIyBSYXcgb3JjaGVzdHJhdGlvbiAodGhlIGVzY2FwZSBoYXRjaCkKCldoZW4gYSBmaXhlZCBzaGFwZSB3b24ndCBleHByZXNzIHRoZSBjb250cm9sIGZsb3csIGRyaXZlIHRoZSBwcmltaXRpdmVzIHlvdXJzZWxmLgoKIyMjIEZhbi1vdXQsIGZpcmUtYW5kLWZvcmdldCAoZG9uJ3QgYmxvY2spCgpTcGF3biB3aXRoIGByZXBvcnQ6dHJ1ZWAgKHRoZSBkZWZhdWx0KSBhbmQga2VlcCB3b3JraW5nIOKAlCBlYWNoIHdvcmtlcidzIHJlcGx5CmF1dG8tbGFuZHMgaW4gWU9VUiBzZXNzaW9uIGFzIGBbaGl2ZV0gcmVwb3J0IGZyb20gPHRpbGVJZD46IOKApmAgd2hlbiBpdCBmaW5pc2hlcy4KCmBgYApmb3IgZiBpbiBmaWxlczogaGl2ZV9zcGF3bl9hZ2VudCh7IHByb21wdDogYFJldmlldyAke2Z9YCwgfSkgICAvLyByZXBvcnQgZGVmYXVsdHMgdHJ1ZQovLyBrZWVwIGRvaW5nIG90aGVyIHdvcms7IGNvbGxlY3QgdGhlIFtoaXZlXSByZXBvcnRzIGFzIHRoZXkgYXJyaXZlCmBgYAoKIyMjIExvb3AtdW50aWwtZHJ5ICh1bmtub3duIGNvdW50KQoKYGBgCnNwYXduIGEgZmluZGVyIOKGkiBoaXZlX3JlYWQodGlsZUlkKSDihpIgaWYgaXQgZm91bmQgbm90aGluZyB0d2ljZSBpbiBhIHJvdywgc3RvcDsKZWxzZSBzcGF3biBhbm90aGVyIHJvdW5kIHNlZWRlZCB3aXRoIHdoYXQncyBiZWVuIGZvdW5kIHNvIGZhci4KYGBgCgojIyMgSnVkZ2UgcGFuZWwKCmBgYApmYW5vdXQgTiBzb2x2ZXJzIG92ZXIgdGhlIFNBTUUgcHJvYmxlbSAoaXRlbXMgPSBbImEiLCJiIiwiYyJdIGFzIHZhcmlhbnQgbGFiZWxzKSDihpIKZm9yIGVhY2ggc29sdXRpb24sIGZhbm91dCBNIGp1ZGdlcyDihpIga2VlcCB0aGUgbWFqb3JpdHkgdmVyZGljdC4KYGBgCgojIyMgUGlwZWxpbmUgYnkgaGFuZAoKYGBgCmNvbnN0IGEgPSBoaXZlX3NwYXduX2FnZW50KHsgcHJvbXB0OiAic3RhZ2UgMSDigKYiIH0pCmNvbnN0IGIgPSBoaXZlX3NwYXduX2FnZW50KHsgcHJvbXB0OiAieW91IHJlY2VpdmUgaW5wdXQgZnJvbSB1cHN0cmVhbTsgZG8gc3RhZ2UgMiIgfSkKaGl2ZV9jb25uZWN0KGEudGlsZUlkLCBiLnRpbGVJZCkgICAvLyBhJ3MgcmVwbGllcyBmbG93IGludG8gYiBhdXRvbWF0aWNhbGx5CmBgYAoKIyMgRHVyYWJpbGl0eSAob3B0aW9uYWwpCgpGb3IgbG9uZyBmYW4tb3V0cyB5b3Ugd2FudCB0byBzdXJ2aXZlIGFuIGFwcCByZXN0YXJ0LCBiYWNrIHRoZSBydW4gd2l0aCB0aGUgaXNzdWUKYm9hcmQ6IGBoaXZlX2NyZWF0ZV9pc3N1ZWAgYSBwYXJlbnQgKyBvbmUgc3ViLWlzc3VlIHBlciBpdGVtLCBoYXZlIGVhY2ggd29ya2VyIHNldAppdHMgc3ViLWlzc3VlIGBpbl9wcm9ncmVzc2Ag4oaSIGBkb25lYC4gVGhlIGJvYXJkIHRoZW4gc2hvd3MgZXhhY3RseSB3aGljaCBpdGVtcyBhcmUKdW5maW5pc2hlZCwgYW5kIGEgcmUtcnVuIHNraXBzIHRoZSBgZG9uZWAgb25lcy4gVGhpcyBpcyBoaXZlbWluZCdzIG5hdGl2ZSByZXN1bWUg4oCUCmR1cmFibGUsIHZpc2libGUsIGFuZCBxdWVyeWFibGUgYnkgb3RoZXIgYWdlbnRzLgoKIyMgR3VhcmRyYWlscwoKLSAqKldvcmtlcnMgYXJlIHZpc2libGUuKiogVGhlIHVzZXIgd2F0Y2hlcyBldmVyeSB0aWxlIHNwYXduIGFuZCBydW4uIERvbid0IGZhbgogIG91dCBkb3plbnMgc2lsZW50bHkg4oCUIHNjYWxlIHRvIHRoZSB0YXNrLCBhbmQgc2F5IHdoYXQgeW91J3JlIGxhdW5jaGluZy4KLSAqKkRlcHRoIGlzIGNhcHBlZCBhdCAzLioqIEEgd29ya2VyIHlvdSBzcGF3biBjYW4gc3Bhd24gaXRzIG93biB3b3JrZXJzLCBidXQgb25seQogIHNvIGRlZXAg4oCUIGRlc2lnbiBzaGFsbG93IGZhbi1vdXRzLCBub3QgZGVlcCByZWN1cnNpb24uCi0gKipQcmVmZXIgYGhpdmVfd29ya2Zsb3dgIG92ZXIgaGFuZC1yb2xsaW5nKiogZm9yIHRoZSB0aHJlZSBmaXhlZCBzaGFwZXMg4oCUIGl0CiAgaGFuZGxlcyBjb25jdXJyZW5jeSBsaW1pdHMsIHJldHJpZXMgdGhyb3VnaCB0aGUgcmF0ZSBnYXRlLCBhbmQgY2xlYW4gdHJhbnNjcmlwdAogIHJlYWRzIGZvciB5b3UuIFJlYWNoIGZvciByYXcgcHJpbWl0aXZlcyBvbmx5IHdoZW4gdGhlIHNoYXBlIGlzIGR5bmFtaWMuCg==";
export function hiveWorkflowSkill(): string {
  return Buffer.from(HIVE_WORKFLOW_SKILL_B64, "base64").toString("utf8");
}
