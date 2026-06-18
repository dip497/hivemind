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
