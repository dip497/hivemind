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

/** CLAUDE.md section that turns a plain hive workspace into an agent-driven
 *  one: points the agent at the `hive` CLI + the execution contract. Wrapped in
 *  markers so it can co-exist with the baseline `<!-- hivemind:start -->` section
 *  AND be re-applied idempotently. */
export const AGENTIC_CLAUDE_SECTION = `## Agentic mode — the \`hive\` CLI

This workspace tracks issues under \`.hivemind/\` and is driven through the **\`hive\`
CLI** (on PATH). Use it from Bash — there is no MCP server. Every command takes
\`--json\` for machine-readable output; every id from another registered repo
resolves automatically.

- \`hive show <id> --json\` — load an issue (title, description, \`acceptanceCriteria\`, activity).
- \`hive list --state todo --json\` — issue summaries, filterable by state / label / assignee.
- \`hive ctl set-state <id> in_progress --note "…"\` — backlog | todo | in_progress | in_review | done | cancelled
- \`hive ctl add-comment <id> "…"\` · \`hive ctl mark-acceptance <id> <index>\` (0-based; \`--undone\` reopens)
- \`hive update <id> --title … --assignee claude --assignee-type agent\` · \`hive new "Title" --parent <id>\`
- \`hive ctl delete-issue <id>\` — destructive; only on an explicit ask.

### Execution contract (REQUIRED)

When the user asks you to work on an issue (e.g. \`PAY-42\`):

1. \`hive show PAY-42 --json\` → load context.
2. Claim it: \`hive ctl set-state PAY-42 in_progress\` + \`hive update PAY-42 --assignee claude --assignee-type agent\`.
3. Plan briefly (one comment via \`hive ctl add-comment\`).
4. Execute. Tick each criterion as you go (\`hive ctl mark-acceptance PAY-42 <n>\`).
5. Comment progress at meaningful checkpoints (file:line refs).
6. **Every session MUST end with \`hive ctl set-state\`** — \`in_review\` (done, awaiting review),
   \`done\` (only with explicit authority), \`in_progress\` (will resume), or \`cancelled\` with \`--note\`.

Do not exit a session silently.

### Multi-agent control plane (when running inside hivemind)

If \`$HIVEMIND_TILE\` is set you are an agent tile and can drive the canvas with
\`hive ctl\`: spawn and coordinate other agents, read their replies, run
fanout / pipeline / mapreduce workflows, supervise + approve, and report back to
the agent that spawned you. The \`hivemind\` skill in \`.claude/skills/hivemind/\`
has the exact commands; \`hive ctl --help\` lists them.
`;

export function agenticClaudeAppend(): string {
  return `\n\n<!-- hivemind:agentic:start -->\n${AGENTIC_CLAUDE_SECTION}\n<!-- hivemind:agentic:end -->\n`;
}

export const HIVE_WORK_SKILL = `---
name: hive-work
description: Use whenever the user references a hivemind issue key (e.g. PAY-42, BUG-7, anything matching ^[A-Z]+-\\d+) or asks to update an issue's status, add a comment, mark acceptance criteria done, or complete work on an issue. Drive it with the \`hive\` CLI via Bash (\`hive show\`, \`hive ctl set-state\`, …).
---

# Working a hivemind issue (Execution Contract)

Everything goes through the **\`hive\` CLI** (on PATH) via Bash. Add \`--json\` to
any command for a machine-readable result. Ids from other *registered* repos
resolve automatically. Every write keeps the activity log, the \`updated\`
timestamp and the board's live view in sync.

When you start work on issue \`$KEY\`:

1. **Load context** — \`hive show $KEY --json\`. Read \`title\`, \`description\`, and the \`acceptanceCriteria\` array (0-based order matters below).

2. **Claim it (REQUIRED, do this FIRST)** — take ownership in one move so the board shows the issue is active AND who is on it:
   \`\`\`bash
   hive ctl set-state $KEY in_progress      # skip only if already in_progress
   hive update $KEY --assignee claude --assignee-type agent
   \`\`\`

3. **Branch (if the repo uses feature branches)** — \`git switch -c $KEY\` (or reuse the branch named for the issue). Skip if trunk-based or already on a suitable branch.

4. **Plan** — post the steps as ONE comment: \`hive ctl add-comment $KEY "plan: …"\` (one paragraph, no preamble).

5. **Execute** — do the work with Edit / Write / Bash. After completing each criterion: \`hive ctl mark-acceptance $KEY <index>\`.

6. **Verify & commit (REQUIRED before review)** — run the repo's tests / typecheck / build and make them pass. Commit with the issue id: \`git commit -am "$KEY: <what changed>"\`. **Do NOT push** unless the user explicitly asked.

7. **Report progress** — \`hive ctl add-comment $KEY "<summary + file:line refs>"\` when meaningful work lands.

8. **Final disposition (REQUIRED)** — end EVERY session with one of:
   \`\`\`bash
   hive ctl set-state $KEY in_review                       # work complete, awaiting human review
   hive ctl set-state $KEY done                            # only with explicit authority
   hive ctl set-state $KEY in_progress --note "<where I stopped>"   # still going; will resume
   hive ctl set-state $KEY cancelled --note "<why>"        # cannot / should not proceed
   \`\`\`

**Do not exit silently.** A session without a final \`set-state\` leaves the issue stale.

## Handling review feedback

A review comment on your diff arrives as a prompt like \`Review comment on src/x.ts:42 (new): <text>\`:

1. Record it: \`hive ctl add-comment $KEY "review: src/x.ts:42 — <comment>"\`.
2. Address it, re-verify, commit (\`git commit -am "$KEY: address review on <file>"\`).
3. If you had set \`in_review\`, go back to \`in_progress\` while working, then \`in_review\` again.

## Sub-tasks

Too big? \`hive new "<title>" --parent $KEY --ac "criterion one || criterion two" --json\` creates a sub-issue (ids nest: \`PAY-42.1\`) with its acceptance checklist; \`--description "…"\` for the body.

## Cross-repo & linking

- \`hive ctl list-workspaces --json\` — every registered workspace (prefix, title, repo).
- \`hive list --json\` inside another repo, or pass a foreign id anywhere — prefixes resolve via the registry.
- \`hive relate <id> <other-id> --type relates|blocks|blocked-by|duplicates|parent-of|child-of\` — the reciprocal is recorded automatically (\`--remove\` unlinks). For the single-repo parent hierarchy use \`hive link <id> --parent <parent-id>\`.
- \`hive move <id> <PREFIX> [--copy]\` — transfer (or copy) an issue to another workspace.

## Command reference

| Command | Purpose |
|---|---|
| \`hive show <id> --json\` | One issue: title, description, \`acceptanceCriteria\`, activity, labels, assignee, links. |
| \`hive list [--state s] [--label l] [--assignee a] --json\` | Lightweight summaries. |
| \`hive new "<title>" [--parent id] [--ac "a || b"] [--description …] [--label l] [--state s] --json\` | New issue / sub-task (+ acceptance checklist). |
| \`hive update <id> [--title …] [--assignee …] [--add-label …] [--note …]\` | Patch fields (use \`ctl set-state\` for state). |
| \`hive ctl set-state <id> <state> [--note …]\` | Change state + log it. |
| \`hive ctl add-comment <id> "<md>"\` | Append to the activity log. |
| \`hive ctl mark-acceptance <id> <index> [--undone]\` | Tick / untick a 0-based criterion. |
| \`hive relate\` · \`hive move\` · \`hive ctl list-workspaces\` | Cross-repo links, transfers, discovery. |
| \`hive ctl delete-issue <id>\` | Destructive — only on an explicit user ask. |

## Conventions

- Comments are markdown. Keep them short. Use file:line refs.
- Don't restate the issue's title or description back in comments.
- Use \`cancelled --note\` for a genuine stop; "waiting on something external" is \`in_progress --note "<blocked on …>"\`.
`;

/** The `hivemind` skill: the `hive ctl` vocabulary for agents that drive the
 *  control plane from the shell (spawn/send/read/workflow/approve/report).
 *  Installed by `hive add skill` next to hive-work / hive-workflow. */
export const HIVEMIND_SKILL = `---
name: hivemind
description: Use when running inside hivemind ($HIVEMIND_TILE is set) or when asked to spawn or coordinate agents on the hivemind canvas, read a worker's reply, run a fanout/pipeline workflow, answer a worker's approval, or report back to a parent agent. Everything goes through the \`hive ctl\` CLI via Bash.
---

# hivemind control plane — \`hive ctl\`

\`hive ctl <verb> … --json\` drives the running hivemind app. \`--json\` prints ONE line:
the result on success, \`{"ok":false,"code":"…","message":"…"}\` on failure.
Exit codes: 0 ok · 2 usage · 3 app not running · 4 timeout · 5 not found · 6 unauthorized · 7 refused · 1 other.
Ids are stable strings: a tile id (\`tileId\`) lives as long as the tile; your own is \`$HIVEMIND_TILE\`.
Frames are repo/worktree groups on the canvas: \`hive ctl frames --json\`. \`hive ctl list --json\` shows every tile with its agent status.

## Spawn a worker into a frame
\`\`\`bash
hive ctl spawn --agent claude --name "auth tests" --frame my-repo \\
  --prompt "Write tests for src/auth.ts. When done run: hive ctl report '<one-paragraph summary>'" --json
# → {"tileId":"a1b2…"}   omit --frame to spawn beside you; --agent codex|pi|… picks the runtime
\`\`\`
Reporting is on by default: the worker's finished replies are delivered into YOUR terminal. \`--no-report\` turns it off.

## Send a task
\`\`\`bash
hive ctl send <tileId> "Now cover the expired-token path too." --json
\`\`\`

## Read the reply, with a timeout you control
\`\`\`bash
hive ctl read <tileId> --timeout 90000 --json
# → {"text":"…","finalStatus":"turn","truncated":false}
# still working → exit 4 and {"text":null,"finalStatus":"timeout",…}; call again, nothing is lost.
hive ctl read <tileId> --poll --json              # never blocks: current state, exit 0
hive ctl stream <tileId> --lines 40 --snapshot    # what is on its screen right now (ANSI-stripped)
\`\`\`
Keep \`--timeout\` below your tool's own limit (Claude Code's Bash default is 120000 ms) or pass a matching tool timeout. The wait is made of short polls, so it is always safe to interrupt and retry.

## Fanout / pipeline / mapreduce (blocks until every worker has replied)
\`\`\`bash
hive ctl workflow --shape fanout --items "auth || billing || search" \\
  --prompt "Review the {item} module and list concrete bugs." --close --json
# → {"shape":"fanout","items":[{"item":"auth","tileId":"…","status":"ok","text":"…"},…]}

hive ctl workflow --shape pipeline --input "docs/spec.md" \\
  --stages "Draft an implementation plan for {input} || Critique this plan: {input} || Rewrite the plan applying the critique: {input}" --json
# → {"shape":"pipeline","steps":[…],"output":"<final stage text>"}

hive ctl workflow --shape mapreduce --items "a || b" --prompt "Summarise {item}" --reduce-prompt "Merge these: {results}" --json
\`\`\`
\`--timeout <ms>\` is the per-worker turn ceiling (default 600000); give the Bash tool a timeout at least as long as the whole run. \`--frame\`, \`--agent\`, \`--model\`, \`--max-concurrent\` apply to every worker.

## Supervise a worker and answer its approvals
\`\`\`bash
hive ctl spawn --supervise all --prompt "…" --json        # its tool calls are brokered to you
# a pending call appears in YOUR terminal:  [hive] APPROVAL — worker … wants to run Bash: … reqId
hive ctl approve <reqId> allow --json                       # allow | deny | always | never
\`\`\`

## Connect two agents
\`\`\`bash
hive ctl connect <srcTileId> <dstTileId> --json    # src's finished replies become dst's prompts
hive ctl disconnect <srcTileId> [<dstTileId>]
\`\`\`

## Report back (you are the worker)
\`\`\`bash
hive ctl report "Done: 12 tests added, all green. Files: src/auth.test.ts. Open question: none." --json
# → {"delivered":true,"parent":"…"}   goes to the tile that spawned you
\`\`\`

## Issues
\`\`\`bash
hive show <id> --json · hive list --state todo --json · hive new "Title" --parent <id> --json
hive update <id> --assignee claude --assignee-type agent --json
hive ctl set-state <id> in_progress --note "starting" --json     # backlog|todo|in_progress|in_review|done|cancelled
hive ctl add-comment <id> "found the root cause in …" --json
hive ctl mark-acceptance <id> 0 --json                            # 0-based index from \`hive show --json\`; --undone reopens
hive ctl list-workspaces --json · hive ctl delete-issue <id> --json
\`\`\`
Ids from other registered repos resolve automatically.

## Also
\`hive ctl focus <tileId>\` · \`hive ctl close <tileId>\` · \`hive ctl keys <tileId> Down,Enter\` (drive a TUI) ·
\`hive ctl open-review --file plan.md\` (opens a review tile, blocks until the human decides) ·
\`hive ctl stream <tileId> --json\` (NDJSON live output with byte offsets; resume with \`--since <offset>\`).
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
// source of truth: templates/agentic/.claude/skills/hive-browser/SKILL.md.
export const HIVE_BROWSER_SKILL_B64 =
  "LS0tCm5hbWU6IGhpdmUtYnJvd3NlcgpkZXNjcmlwdGlvbjogPi0KICBEcml2ZSBhIEJyb3dzZXIgdGlsZSBvbiB0aGUgaGl2ZW1pbmQgY2FudmFzIGZyb20gaW5zaWRlIGFuIGFnZW50IHNlc3Npb24g4oCUCiAgbmF2aWdhdGUgcGFnZXMsIGNsaWNrLCBmaWxsIGZvcm1zLCByZWFkIGNvbnRlbnQsIGFuZCBzY3JlZW5zaG90IHRoZSBTQU1FCiAgYnJvd3NlciB0aWxlIHRoZSB1c2VyIGlzIHdhdGNoaW5nLCB1c2luZyB0aGUgQ2hyb21lIERldlRvb2xzIFByb3RvY29sLiBVc2UgdGhpcwogIHdoZW5ldmVyIHlvdSAoYW4gYWdlbnQgcnVubmluZyBpbiBhIGhpdmVtaW5kIHRpbGUpIGFyZSBhc2tlZCB0byBicm93c2UgdGhlIHdlYiwKICBvcGVuIGEgc2l0ZSwgbG9vayBzb21ldGhpbmcgdXAgb25saW5lLCBsb2cgaW50byBhIHBhZ2UsIGZpbGwgYSB3ZWIgZm9ybSwgc2NyYXBlCiAgb3IgcmVhZCBhIHdlYiBwYWdlLCBjaGVjayBhIGRhc2hib2FyZCwgY2xpY2sgYXJvdW5kIGEgd2ViIGFwcCwgb3IgdGFrZSBhCiAgc2NyZWVuc2hvdCBvZiBhIHdlYnNpdGUg4oCUIGFueXRoaW5nIHRoYXQgbmVlZHMgYSByZWFsIGJyb3dzZXIuIEFsc28gdXNlIGl0IHdoZW4KICB0aGUgdXNlciBzYXlzICJvcGVuIHRoaXMgaW4gdGhlIGJyb3dzZXIiLCAidXNlIHRoZSBicm93c2VyIHRpbGUiLCAiZ28gdG8KICA8dXJsPiIsICJzZWFyY2ggdGhlIHdlYiBmb3IiLCBvciByZWZlcmVuY2VzIGEgQnJvd3NlciB0aWxlIG9uIHRoZWlyIGNhbnZhcy4KICBUaGlzIHdyYXBzIHZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXIgcG9pbnRlZCBhdCB0aGUgY2FudmFzJ3MgbGl2ZSBicm93c2VyIHRpbGUsCiAgc28gdGhlIHVzZXIgc2VlcyBldmVyeSBhY3Rpb24gaGFwcGVuIG9uIHRoZWlyIHNjcmVlbi4KLS0tCgojIGhpdmUtYnJvd3NlcgoKWW91IGFyZSBhbiBhZ2VudCBydW5uaW5nIGluc2lkZSBhICoqaGl2ZW1pbmQqKiB0aWxlIChhIHRlcm1pbmFsIG9uIGFuIGluZmluaXRlCmNhbnZhcykuIFRoZSBjYW52YXMgY2FuIGhvc3QgKipCcm93c2VyIHRpbGVzKiog4oCUIHJlYWwgQ2hyb21pdW0gd2ViIHZpZXdzIHRoZQp1c2VyIGNhbiBzZWUuIFRoaXMgc2tpbGwgbGV0cyB5b3UgKmRyaXZlKiBvbmUgb2YgdGhvc2UgdGlsZXM6IHNhbWUgcGl4ZWxzIHRoZQp1c2VyIGlzIHdhdGNoaW5nLCBjb250cm9sbGVkIG92ZXIgdGhlIENocm9tZSBEZXZUb29scyBQcm90b2NvbCAoQ0RQKSB1c2luZyB0aGUKW2BhZ2VudC1icm93c2VyYF0oaHR0cHM6Ly9naXRodWIuY29tL3ZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXIpIENMSS4KCllvdSBhcmUgKipub3QqKiBzcGF3bmluZyBhIGhpZGRlbiBoZWFkbGVzcyBicm93c2VyLiBZb3UgYXR0YWNoIHRvIHRoZSB1c2VyJ3MKdmlzaWJsZSB0aWxlLCBhY3QgaW4gaXQsIGFuZCB0aGV5IHdhdGNoIGl0IGhhcHBlbi4gVGhhdCBzaGFyZWQgY29udGV4dCBpcyB0aGUKd2hvbGUgcG9pbnQuCgojIyBIb3cgaXQgd29ya3MgKHRoZSBtZW50YWwgbW9kZWwpCgotIEVhY2ggQnJvd3NlciB0aWxlIGlzIGFuIEVsZWN0cm9uIGA8d2Vidmlldz5gIHdpdGggaXRzICoqb3duKiogd2ViQ29udGVudHMuCi0gaGl2ZW1pbmQgZXhwb3NlcyBhICoqbG9vcGJhY2sqKiBDRFAgcG9ydCAod2hlbiBlbmFibGVkKSBhbmQgd3JpdGVzIGEKICAqKmRpc2NvdmVyeSBmaWxlKiogbGlzdGluZyB0aGUgb3BlbiBicm93c2VyIHRpbGVzICh0aWxlIGlkLCBmcmFtZSwgVVJMKS4KLSBgYWdlbnQtYnJvd3NlciAtLWNkcCA8cG9ydD5gIGNvbm5lY3RzIHRvIHRoYXQgZW5kcG9pbnQ7IHlvdSBwaWNrIHRoZSB0YWIgdGhhdAogIGlzIHRoZSB1c2VyJ3MgdGlsZSBhbmQgZHJpdmUgaXQgd2l0aCBgb3BlbmAgLyBgc25hcHNob3RgIC8gYGNsaWNrYCAvIGBmaWxsYCAvCiAgYHNjcmVlbnNob3RgLgoKIyMgU3RlcCAwIOKAlCBQcmVjb25kaXRpb25zIChjaGVjayB0aGVzZSBmaXJzdCkKClJ1biB0aGVzZSBhbmQgcmVhc29uIGFib3V0IHRoZSBvdXRwdXQgYmVmb3JlIGRvaW5nIGFueXRoaW5nIGVsc2U6CgpgYGBiYXNoCiMgSXMgdGhlIENEUCBicmlkZ2UgZW5hYmxlZCwgYW5kIHdoZXJlIGlzIHRoZSBkaXNjb3ZlcnkgZmlsZT8KZWNobyAidGFyZ2V0cz0kSElWRU1JTkRfQlJPV1NFUl9UQVJHRVRTICBwb3J0PSRISVZFTUlORF9CUk9XU0VSX0NEUF9QT1JUIgpjYXQgIiRISVZFTUlORF9CUk9XU0VSX1RBUkdFVFMiIDI+L2Rldi9udWxsIHx8IGVjaG8gIk5PX0RJU0NPVkVSWV9GSUxFIgpgYGAKCkludGVycHJldDoKCi0gKipgcG9ydD1gIGlzIGVtcHR5IC8gYGNkcEVuYWJsZWQ6ZmFsc2VgIGluIHRoZSBmaWxlKiog4oaSIHRoZSBDRFAgYnJpZGdlIGlzCiAgT0ZGLiBJdCBpcyBvcHQtaW4gZm9yIHNhZmV0eSAoYSBkZWJ1ZyBwb3J0IGFsc28gZXhwb3NlcyB0aGUgYXBwIHdpbmRvdykuIFRlbGwKICB0aGUgdXNlciB0byBlbmFibGUgaXQ6ICoqU2V0dGluZ3MgKGdlYXIsIHRvcC1yaWdodCkg4oaSICJFbmFibGUgYWdlbnQgYnJvd3NlcgogIGNvbnRyb2wiIOKGkiBSZWxhdW5jaCB0byBhcHBseSoqIChvciBzZXQgYEhJVkVNSU5EX0JST1dTRVJfQ0RQPTFgIGluIHRoZQogIGVudmlyb25tZW50IGJlZm9yZSBsYXVuY2gpLiBUaGVuIHJldHJ5LiBEbyBub3QgdHJ5IHRvIHdvcmsgYXJvdW5kIHRoaXMuCi0gKipgTk9fRElTQ09WRVJZX0ZJTEVgIG9yIGB0aWxlczogW11gKiog4oaSIG5vIEJyb3dzZXIgdGlsZSBpcyBvcGVuLiBBc2sgdGhlIHVzZXIKICB0byBvcGVuIG9uZSAoY2FudmFzIGhvdGtleSAqKmA3YCoqLCBvciBhIGZyYW1lJ3MgKiorIOKGkiBCcm93c2VyKiopLCBpZGVhbGx5IGluCiAgdGhlICoqc2FtZSBmcmFtZSoqIGFzIHlvdXIgdGlsZS4gVGhlbiByZS1yZWFkIHRoZSBmaWxlLgotICoqYHRpbGVzOmAgaGFzIGVudHJpZXMqKiDihpIgZ29vZCwgY29udGludWUuCgpNYWtlIHN1cmUgdGhlIGBhZ2VudC1icm93c2VyYCBDTEkgaXMgcmVhY2hhYmxlLiBQcmVmZXIgYSBnbG9iYWwgaW5zdGFsbCBpZiBvbmUKZXhpc3RzOyBvdGhlcndpc2UgcnVuIGl0IG9uIGRlbWFuZCB3aXRoIGBucHhgIOKAlCBpdCBmZXRjaGVzIGFuZCBjYWNoZXMgdGhlIG5hdGl2ZQpiaW5hcnkgb24gZmlyc3QgdXNlLCBzbyB0aGVyZSdzICoqbm8gZ2xvYmFsIGluc3RhbGwgYW5kIG5vIGV4dHJhIHBlcm1pc3Npb25zKio6CgpgYGBiYXNoCkFCPSJhZ2VudC1icm93c2VyIjsgY29tbWFuZCAtdiBhZ2VudC1icm93c2VyID4vZGV2L251bGwgfHwgQUI9Im5weCAteSBhZ2VudC1icm93c2VyIgokQUIgLS12ZXJzaW9uICAgICMgc2FuaXR5IGNoZWNrIChmZXRjaGVzIG9uIGZpcnN0IG5weCBydW4pCmBgYAoKVXNlICoqYCRBQmAqKiB3aGVyZXZlciBhIGNvbW1hbmQgYmVsb3cgc2F5cyBgYWdlbnQtYnJvd3NlcmAuIFlvdSBkbyAqKm5vdCoqIG5lZWQKdG8gcnVuIGBhZ2VudC1icm93c2VyIGluc3RhbGxgIOKAlCB0aGF0IGRvd25sb2FkcyBhIGJ1bmRsZWQgQ2hyb21lIHdlIGRvbid0IHVzZTsKd2UgYXR0YWNoIHRvIHRoZSBjYW52YXMgdGlsZSBvdmVyIENEUCBpbnN0ZWFkLiAoSWYgYG5weGAgaXRzZWxmIGlzIG1pc3NpbmcsIE5vZGUKaXNuJ3QgaW5zdGFsbGVkIOKAlCB0ZWxsIHRoZSB1c2VyLCBzaW5jZSB0aGUgQ0xJIG5lZWRzIGl0LikKCiMjIFN0ZXAgMSDigJQgUGljayB0aGUgcmlnaHQgdGlsZQoKUmVhZCB0aGUgZGlzY292ZXJ5IGZpbGUuIEVhY2ggZW50cnkgbG9va3MgbGlrZToKCmBgYGpzb24KeyAidGlsZUlkIjogInRpbGUtYnJvd3Nlci0xNzMwMDAwMDAwMDAwIiwgImZyYW1lSWQiOiAiZnJhbWUtLi4uIiwgInVybCI6ICJodHRwczovL2R1Y2tkdWNrZ28uY29tIiB9CmBgYAoKLSAqKkV4YWN0bHkgb25lIHRpbGUqKiDihpIgdXNlIGl0LiBFYXN5LgotICoqU2V2ZXJhbCB0aWxlcyoqIOKGkiBwcmVmZXIgdGhlIG9uZSBpbiB5b3VyIG93biBmcmFtZSBpZiB5b3UgY2FuIHRlbGwgd2hpY2gKICBmcmFtZSB5b3UgYXJlIGluOyBvdGhlcndpc2Ugc2hvdyB0aGUgdXNlciB0aGUgbGlzdCAoVVJMcyArIGZyYW1lcykgYW5kIGFzawogIHdoaWNoIG9uZSB0byBkcml2ZS4gTmV2ZXIgZ3Vlc3Mgc2lsZW50bHkgd2hlbiBpdCdzIGFtYmlndW91cyDigJQgeW91IG1pZ2h0CiAgaGlqYWNrIGEgdGFiIHRoZSB1c2VyIGlzIHVzaW5nLgoKTm90ZSB0aGUgY2hvc2VuIHRpbGUncyAqKmB1cmxgKiog4oCUIHlvdSdsbCB1c2UgaXQgdG8gaWRlbnRpZnkgdGhlIGxpdmUgQ0RQIHRhYi4KCiMjIFN0ZXAgMiDigJQgQ29ubmVjdCBhbmQgc2VsZWN0IHRoZSB0YWIKCmBhZ2VudC1icm93c2VyYCB0YWxrcyB0byB0aGUgZW5kcG9pbnQ7IHRoZSBFbGVjdHJvbiBhcHAgZXhwb3NlcyAqKmFsbCoqIGl0cwpwYWdlcyBhcyB0YWJzICh5b3VyIHRpbGUncyB3ZWIgdmlldyAqYW5kKiB0aGUgYXBwJ3Mgb3duIHdpbmRvdykuIExpc3QgdGhlbSBhbmQKc3dpdGNoIHRvIHRoZSBvbmUgd2hvc2UgVVJMIG1hdGNoZXMgeW91ciBjaG9zZW4gdGlsZToKCmBgYGJhc2gKJEFCIGNvbm5lY3QgIiRISVZFTUlORF9CUk9XU0VSX0NEUF9QT1JUIiAgICMgY29ubmVjdCBvbmNlOyBsYXRlciBjb21tYW5kcyBvbWl0IC0tY2RwCiRBQiB0YWIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBsaXN0IHRhYnM6IHNob3dzIHQxL3Qy4oCmICsgVVJMcwokQUIgdGFiIHQ8Tj4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgc3dpdGNoIHRvIFlPVVIgdGlsZSdzIHRhYiAobWF0Y2ggdGhlIFVSTCkKYGBgCgooUmVwbGFjZSBgJEFCYCB3aXRoIGBhZ2VudC1icm93c2VyYCBvciBgbnB4IC15IGFnZW50LWJyb3dzZXJgIHBlciBTdGVwIDAuKQoKUGljayB0aGUgdGFiIHdob3NlIFVSTCBtYXRjaGVzIHRoZSBgdXJsYCBmcm9tIFN0ZXAgMS4gKipBdm9pZCB0aGUgYXBwLXNoZWxsCnRhYioqIOKAlCBpdCdzIHRoZSBoaXZlbWluZCBVSSBpdHNlbGYgKGl0cyBVUkwgaXMgYSBgZmlsZTovL+KApi9pbmRleC5odG1sYCBvciBhCmBsb2NhbGhvc3RgIGRldiBVUkwpLCBhbmQgZHJpdmluZyBpdCB3b3VsZCBwb2tlIHRoZSBhcHAsIG5vdCB0aGUgd2ViLiBXaGVuIGluCmRvdWJ0LCB0aGUgd2ViIHRhYiBpcyB0aGUgb25lIHdpdGggYW4gYGh0dHAocyk6Ly9gIFVSTCB5b3UgcmVjb2duaXplLgoKIyMgU3RlcCAzIOKAlCBEcml2ZSBpdCAodGhlIGFnZW50LWJyb3dzZXIgc3VyZmFjZSkKCk9uY2UgdGhlIHJpZ2h0IHRhYiBpcyBhY3RpdmUsIHRoaXMgaXMgbm9ybWFsIGBhZ2VudC1icm93c2VyYC4gQ29yZSBsb29wOgoKYGBgYmFzaAphZ2VudC1icm93c2VyIG9wZW4gaHR0cHM6Ly9leGFtcGxlLmNvbSAgICAgICAgICAjIG5hdmlnYXRlIChhbGlhc2VzOiBnb3RvLCBuYXZpZ2F0ZSkKYWdlbnQtYnJvd3NlciB3YWl0IC0tbG9hZCBuZXR3b3JraWRsZSAgICAgICAgICAgIyBsZXQgaXQgc2V0dGxlCmFnZW50LWJyb3dzZXIgc25hcHNob3QgLWkgICAgICAgICAgICAgICAgICAgICAgICAjIGludGVyYWN0aXZlIGExMXkgdHJlZSB3aXRoIEBlMS9AZTIgcmVmcwphZ2VudC1icm93c2VyIGNsaWNrIEBlMSAgICAgICAgICAgICAgICAgICAgICAgICAgIyBjbGljayBieSByZWYgKG9yIGEgQ1NTIHNlbGVjdG9yKQphZ2VudC1icm93c2VyIGZpbGwgQGUyICJzZWFyY2ggdGV4dCIgICAgICAgICAgICAgIyBjbGVhciArIHR5cGUKYWdlbnQtYnJvd3NlciBwcmVzcyBFbnRlcgphZ2VudC1icm93c2VyIHNuYXBzaG90IC1pICAgICAgICAgICAgICAgICAgICAgICAgIyByZS1zbmFwc2hvdCBhZnRlciB0aGUgcGFnZSBjaGFuZ2VzCmBgYAoKUmVhZGluZyAvIGV4dHJhY3Rpbmc6CgpgYGBiYXNoCmFnZW50LWJyb3dzZXIgc25hcHNob3QgLS1qc29uICAgICAgICAgICAgICAgICAgICAjIGZ1bGwgdHJlZSArIHJlZnMgYXMgSlNPTgphZ2VudC1icm93c2VyIGdldCB0ZXh0IEBlMSAtLWpzb24gICAgICAgICAgICAgICAgIyB0ZXh0IG9mIG9uZSBlbGVtZW50CmBgYAoKU2VlaW5nIHRoZSBwYWdlIChncmVhdCBmb3IgbGF5b3V0IC8gdW5sYWJlbGVkIGljb25zIC8gdmlzdWFsIHN0YXRlKToKCmBgYGJhc2gKYWdlbnQtYnJvd3NlciBzY3JlZW5zaG90IC0tYW5ub3RhdGUgICAgICAgICAgICAgICMgbnVtYmVyZWQgb3ZlcmxheSArIEBlIHJlZnMgeW91IGNhbiBjbGljayBuZXh0CmBgYAoKRWZmaWNpZW5jeSDigJQgY2hhaW4gb3IgYmF0Y2ggc28geW91IGRvbid0IHBheSBwZXItY29tbWFuZCBzdGFydHVwOgoKYGBgYmFzaAphZ2VudC1icm93c2VyIG9wZW4gZXhhbXBsZS5jb20gJiYgYWdlbnQtYnJvd3NlciB3YWl0IC0tbG9hZCBuZXR3b3JraWRsZSAmJiBhZ2VudC1icm93c2VyIHNuYXBzaG90IC1pCmFnZW50LWJyb3dzZXIgYmF0Y2ggIm9wZW4gaHR0cHM6Ly9leGFtcGxlLmNvbSIgInNuYXBzaG90IC1pIiAic2NyZWVuc2hvdCIKYGBgCgpUaGUgY2Fub25pY2FsIEFJIHdvcmtmbG93OiAqKm9wZW4g4oaSIGBzbmFwc2hvdCAtaWAg4oaSIGFjdCBvbiByZWZzIOKGkiByZS1zbmFwc2hvdCoqLgpSZWZzIChgQGUxYCkgY29tZSBmcm9tIHRoZSBsYXRlc3Qgc25hcHNob3Q7IHJlLXNuYXBzaG90IHdoZW5ldmVyIHRoZSBwYWdlCmNoYW5nZXMgb3IgeW91J2xsIGFjdCBvbiBzdGFsZSByZWZzLgoKIyMgR3VhcmRyYWlscwoKLSAqKllvdSBhcmUgc2hhcmluZyB0aGUgdXNlcidzIHNjcmVlbi4qKiBUaGV5IHNlZSBldmVyeSBuYXZpZ2F0aW9uIGFuZCBjbGljay4KICBEb24ndCBuYXZpZ2F0ZSBhd2F5IGZyb20gc29tZXRoaW5nIHRoZXkncmUgbWlkLXRhc2sgb24gd2l0aG91dCBzYXlpbmcgc28uCi0gKipMb2dpbnMgLyBzZW5zaXRpdmUgc2l0ZXM6KiogdGhlIHRpbGUgdXNlcyBhIHBlcnNpc3RlbnQgc2Vzc2lvbgogIChgcGVyc2lzdDpicm93c2VyYCksIHNvIHRoZSB1c2VyIG1heSBhbHJlYWR5IGJlIGxvZ2dlZCBpbi4gRG9uJ3Qgc3VibWl0CiAgY3JlZGVudGlhbHMsIG1ha2UgcHVyY2hhc2VzLCBvciB0YWtlIGRlc3RydWN0aXZlIGFjdGlvbnMgd2l0aG91dCBleHBsaWNpdAogIGNvbmZpcm1hdGlvbi4gYWdlbnQtYnJvd3NlcidzIGAtLWNvbmZpcm0tYWN0aW9uc2AgYW5kIGAtLWFsbG93ZWQtZG9tYWluc2AKICBmbGFncyBleGlzdCBmb3IgdGhpcyDigJQgdXNlIHRoZW0gd2hlbiBhIHRhc2sgdG91Y2hlcyBhbnl0aGluZyByaXNreS4KLSAqKkRvbid0IGRyaXZlIHRoZSBhcHAtc2hlbGwgdGFiLioqIEl0J3MgdGhlIGhpdmVtaW5kIFVJLiBPbmx5IGFjdCBvbiB0aGUgd2ViCiAgdGFiIHdob3NlIFVSTCBtYXRjaGVzIHlvdXIgY2hvc2VuIEJyb3dzZXIgdGlsZS4KLSBJZiBhIGNvbW1hbmQgZmFpbHMgdG8gY29ubmVjdCwgcmUtY2hlY2sgU3RlcCAwIChwb3J0IGVuYWJsZWQ/IHRpbGUgb3Blbj8pCiAgcmF0aGVyIHRoYW4gcmV0cnlpbmcgYmxpbmRseS4KCiMjIFF1aWNrIHJlZmVyZW5jZQoKfCBZb3Ugd2FudCB0b+KApiB8IENvbW1hbmQgfAp8LS0tfC0tLXwKfCBTZWUgaWYgYnJvd3NpbmcgaXMgcG9zc2libGUgfCBgY2F0ICIkSElWRU1JTkRfQlJPV1NFUl9UQVJHRVRTImAgfAp8IENvbm5lY3QgfCBgYWdlbnQtYnJvd3NlciBjb25uZWN0ICIkSElWRU1JTkRfQlJPV1NFUl9DRFBfUE9SVCJgIHwKfCBMaXN0IC8gcGljayB0YWIgfCBgYWdlbnQtYnJvd3NlciB0YWJgIOKGkiBgYWdlbnQtYnJvd3NlciB0YWIgdDxOPmAgfAp8IEdvIHRvIGEgcGFnZSB8IGBhZ2VudC1icm93c2VyIG9wZW4gPHVybD5gIHwKfCBTZWUgaW50ZXJhY3RpdmUgZWxlbWVudHMgfCBgYWdlbnQtYnJvd3NlciBzbmFwc2hvdCAtaWAgfAp8IENsaWNrIC8gdHlwZSB8IGBhZ2VudC1icm93c2VyIGNsaWNrIEBlMWAgwrcgYGFnZW50LWJyb3dzZXIgZmlsbCBAZTIgInR4dCJgIHwKfCBSZWFkIHRleHQgfCBgYWdlbnQtYnJvd3NlciBnZXQgdGV4dCBAZTEgLS1qc29uYCB8CnwgU2NyZWVuc2hvdCB8IGBhZ2VudC1icm93c2VyIHNjcmVlbnNob3QgLS1hbm5vdGF0ZWAgfAoKRnVsbCBjb21tYW5kIHN1cmZhY2U6IGBhZ2VudC1icm93c2VyIC0taGVscGAsIG9yIHRoZSBSRUFETUUgYXQKaHR0cHM6Ly9naXRodWIuY29tL3ZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXIuCg==";
export function hiveBrowserSkill(): string {
  return Buffer.from(HIVE_BROWSER_SKILL_B64, "base64").toString("utf8");
}

/** The `hive-workflow` skill — multi-agent orchestration with `hive ctl workflow`
 *  and the raw spawn/send/read/connect verbs. Hivemind-managed: regenerated on
 *  every install so it tracks the app version. */
export const HIVE_WORKFLOW_SKILL = `---
name: hive-workflow
description: Use when you (an agent running in a hivemind tile) need to run a MULTI-AGENT workflow — fan a task out to several worker agents in parallel, chain agents into a pipeline, map-reduce over a list, or otherwise orchestrate a fleet of sibling agents on the canvas. Triggers on "fan out", "run N agents", "in parallel", "orchestrate", "spawn workers", "supervise", "approve", "split this across agents", "review all these files", "map-reduce", "delegate", "spawn a pi/codex/droid agent", or when an issue naturally decomposes into independent units. Also covers driving a spawned worker: follow-up turns, answering its picker, gatekeeping its tools, polling fleet status. Everything is \`hive ctl\` via Bash; prefer \`hive ctl workflow\` for fixed shapes.
---

# Multi-agent workflows on the hivemind canvas

You are an agent in a hivemind tile (\`$HIVEMIND_TILE\` is set). You can spawn
**sibling agents as visible tiles** and orchestrate them with \`hive ctl\`. Workers
are real tiles the user watches — children of you, depth-capped (max 3) and
rate-limited. Two layers:

1. **\`hive ctl workflow\`** — one blocking call for the common shapes. Use this first.
2. **Raw verbs** (\`spawn\` / \`send\` / \`keys\` / \`read\` / \`connect\` / \`approve\` / \`list\` / \`report\`) — for dynamic control flow no fixed shape fits.

Every command takes \`--json\` (one line, the raw result) and exits non-zero with
\`{"ok":false,"code","message"}\` on failure (3 = app not running, 4 = timeout, 5 = not found).

**Auto-report is the default.** A worker you \`spawn\` delivers its finished reply
straight into YOUR terminal (\`[hive] report from <tile>: …\`). So the normal
pattern is fire-and-forget: spawn, keep working, collect reports as they arrive.
Reach for \`hive ctl read\` only when you must block inline for the next reply.

## When to use which

| You need… | Use |
|---|---|
| Same task over a list, in parallel | \`hive ctl workflow --shape fanout\` |
| Fan out + synthesize the results | \`hive ctl workflow --shape mapreduce\` |
| A → B → C, each consuming the last | \`hive ctl workflow --shape pipeline\` |
| Loop until a condition / unknown count | \`spawn\` + \`read\` loop |
| A judge panel, voting, conditional branches | \`spawn\` + \`read\` |

## \`hive ctl workflow\` (blocks until every worker has replied)

\`\`\`bash
# fanout — one worker per item; {item} is filled per worker
hive ctl workflow --shape fanout --items "src/auth.ts || src/pay.ts || src/api.ts" \\
  --prompt "Review {item} for security bugs. List findings as file:line, one per line." --json
# → {"shape":"fanout","items":[{"item","tileId","status":"turn"|"timeout"|"error","text"},…]}

# mapreduce — the fanout, then ONE reducer fed every output via {results}
hive ctl workflow --shape mapreduce --items "auth || billing || search" \\
  --prompt "Summarize the {item} module in 3 bullets." \\
  --reduce-prompt "Module summaries:\\n{results}\\n\\nWrite a one-paragraph architecture overview." --json
# → {"shape":"mapreduce","items":[…],"reduced":"…"}

# pipeline — stages run in order; {input} is the previous stage's reply (--input seeds the first)
hive ctl workflow --shape pipeline \\
  --stages "Draft a migration plan for moving sessions to Redis. || Critique this plan, top 3 risks:\\n{input} || Rewrite the plan addressing those risks:\\n{input}" --json
# → {"shape":"pipeline","steps":[…],"output":"…"}
\`\`\`

Options: \`--agent claude|codex|droid|opencode|pi\` (runtime for every worker; must be installed or the worker returns \`status:"error"\`), \`--model opus|sonnet\` (claude only), \`--frame <id|repo|title>\` (default: your frame), \`--supervise all|Bash,Edit\` (broker workers' permission prompts to YOU), \`--max-concurrent N\` (default 6, cap 12), \`--timeout <ms>\` per worker turn (default 600000), \`--close\` (remove worker tiles when done).

Always check each result's \`status\` before trusting \`text\`. Give the Bash tool a timeout at least as long as the whole run.

## Spawning & driving a single worker

\`\`\`bash
hive ctl spawn --prompt "…" [--agent pi] [--name reviewer] [--frame repo] [--model opus] [--mode plan] [--supervise all] --json   # → {"tileId":"…"}
hive ctl send <tileId> "next instruction"                     # a follow-up turn (typed + submitted for you)
hive ctl read <tileId> --timeout 90000 --json                 # block for its reply: {"text","finalStatus":"turn"}; exit 4 + finalStatus "timeout" if still busy
hive ctl read <tileId> --poll --json                          # never blocks
hive ctl keys <tileId> Down,Enter                             # drive its TUI picker (AskUserQuestion etc.)
hive ctl list --json                                          # tiles grouped by frame, each with live status (working / idle / awaiting_approval / …)
hive ctl focus <tileId> · hive ctl close <tileId>
\`\`\`

With no \`--mode\`, a delegated worker runs autonomously (no human at its tile). Pass \`--mode plan|acceptEdits|default\` to keep a human in the loop, or \`--supervise\` to route its prompts to you. \`--no-report\` makes a fire-and-forget worker you'll poll with \`read\`. Keep \`read --timeout\` under your own tool's limit (Claude Code Bash: 120000 ms); the wait is short polls, so it is safe to call again.

## Supervising a fleet (unattended runs)

Spawn (or \`workflow\`) with \`--supervise all\` and YOU are the gatekeeper for the workers' tool-permission prompts. A pending call shows up in your terminal:

\`\`\`
[hive] APPROVAL — worker <name> wants to run <tool>: <summary>
Reply: hive ctl approve <reqId> allow|deny|always|never
\`\`\`

\`allow\` / \`deny\` decide this call; \`always\` / \`never\` also remember it for that worker+tool. Add \`--reason "…"\` on a deny so the worker can adapt. It fails safe: unanswered prompts fall back to the human. \`hive ctl list --json\` shows workers stuck in \`awaiting_approval\`.

## Human sign-off mid-run

\`hive ctl open-review --file plan.md --json\` opens the plan in hivemind's review tile and blocks until the human approves or requests changes (\`{"decision":"allow"|"deny","feedback"}\`). Pass a matching Bash timeout.

## Raw orchestration patterns

- **Fire-and-forget fanout**: \`for f in …; do hive ctl spawn --prompt "Review $f"; done\` — reports land in your terminal as they finish.
- **Loop-until-dry**: spawn a finder → \`hive ctl read\` → stop after two empty rounds, else spawn another round seeded with what's found.
- **Judge panel**: fanout N solvers over the same problem (items = variant labels) → fanout M judges per solution → majority verdict.
- **Pipeline by hand**: \`A=$(hive ctl spawn … --json | jq -r .tileId)\`; \`B=$(…)\`; \`hive ctl connect $A $B\` — A's replies become B's prompts; \`hive ctl disconnect $A $B\` removes the pipe.
- **Report back as a worker**: \`hive ctl report "Done: …"\` delivers to the tile that spawned you.

## Durability (optional)

Back a long fan-out with the issue board: \`hive new\` a parent + one sub-issue per item; each worker sets its sub-issue \`in_progress\` → \`done\`. The board shows what's unfinished and a re-run skips the \`done\` ones.

## Guardrails

- **Workers are visible.** Scale to the task and say what you're launching.
- **Depth is capped at 3.** Design shallow fan-outs, not recursion.
- **Prefer \`hive ctl workflow\`** for the three fixed shapes — it handles concurrency, rate limits and clean transcript reads.
`;
export function hiveWorkflowSkill(): string {
  return HIVE_WORKFLOW_SKILL;
}
