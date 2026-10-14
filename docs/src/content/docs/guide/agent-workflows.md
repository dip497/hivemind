---
title: Agent workflows
description: Coordinate agents with the hive CLI.
---

## Installed skills

`hive init` writes four skills to `.claude/skills/` plus an agentic section in
`CLAUDE.md`; `hive add skill` refreshes them:

| Skill | Activates on |
|---|---|
| `hive-work` | An issue key (`MYP-42`) or status/comment/acceptance request — the execution contract |
| `hive-workflow` | Multi-agent orchestration requests |
| `hivemind` | Running inside hivemind (`$HIVEMIND_TILE` set) or coordination requests |
| `hive-browser` | Web browsing from a hivemind tile |

Everything runs through the `hive` CLI from Bash; any runtime that executes shell
commands can participate. State flow: CLI → markdown write → filesystem watcher → board
tile.

## Execution contract (per issue)

1. `hive show MYP-42 --json` — read title, description, `acceptanceCriteria` (0-based
   order matters below).
2. Claim: `hive ctl set-state MYP-42 in_progress`, then
   `hive update MYP-42 --assignee <agent> --assignee-type agent`.
3. Branch if the repo uses feature branches (`git switch -c MYP-42`).
4. Post the plan as one comment: `hive ctl add-comment MYP-42 "plan: …"`.
5. Work; after each criterion: `hive ctl mark-acceptance MYP-42 <index>`.
6. Verify (tests/typecheck/build), commit with the id. Do not push unless asked.
7. End with a disposition — every session:
   `in_review`, `done` (explicit authority only), `in_progress --note "<stopped at>"`,
   or `cancelled --note "<why>"`.

A session without a final `set-state` leaves the issue stale. Review comments from the
Code tile's Changes arrive as prompts (`Review comment on src/x.ts:42 …`); record, fix, re-verify,
and return to `in_review`.

## Drive other agents

`hive ctl` drives the workspace: in an agent's terminal as that agent, in its workspace; in any
other terminal as you. An agent finds the socket in `HIVE_DRIVE_SOCK`.

```bash
# Who is there, and what each waits on; --watch follows turns, waits and answers
hive ctl agents --watch

# Start a worker with its default model
hive ctl spawn --agent pi --prompt "Review the current diff and report concrete bugs."

# Fanout; worker tiles close after replies are gathered
hive ctl workflow --shape fanout --items "auth || billing || search" \
  --prompt "Review the {item} module and list concrete bugs." --close --json
```

Practical rules:

- Durations take units: `--timeout 90s`, `10m`. A bare number is milliseconds, and one
  under 1000 is refused rather than read as a near-zero wait.
- Keep `read --timeout` below your tool's Bash limit (default wait is 100 s, built from
  ≤ 10 s polls, so retrying is safe). A timeout exits 4 with `finalStatus:"timeout"`;
  call `read` again to collect the turn. A worker closed while you wait exits 5 with
  `finalStatus:"closed"` at once: it is gone, so do not read it again. A worker that stops to
  wait on an answer exits 8 with `finalStatus:"waiting"` at once, and what it waits on.
- What other agents send you (replies, reports, waits, approvals) waits in your inbox:
  `hive ctl inbox` (`--wait 90s` to block for one). Your terminal is only told to read it, at your
  prompt; nothing an agent wrote is typed into it.
- `send` waits until the worker's turn ends; `send --interrupt` stops the turn first.
- `workflow --agent <id>` exits 7 before spawning when that agent has no turn signal;
  `hive agents list` shows which do.
- `hive ctl stream <tile> --snapshot` shows the last 40 lines a tile printed (ANSI-stripped)
  for runtimes that cannot be read deterministically.
- `hive ctl open-review --file plan.md` opens a review tile and waits for a human
  decision (default ceiling 24 h).
- A worker that stops on a question or a permission tells the agent that spawned it, in its
  inbox, with its question, its options and the commands to see and answer it.
- `hive ctl workflow` runs in the CLI, so you can run one from your own terminal (`--repo`).

A program of your own (an orchestrator, a bot) drives agents the same way with a token of its
own: `hive grant create <name> -w <folder>` prints it, `--role agents` lets it start, follow and
answer agents but not push, share the workspace or write files. Settings ▸ API access lists the
tokens and takes them back. The protocol is `spec/workspace-api.md`.

## Supervision

`spawn --supervise all` (or a tool list) routes a worker's permission prompts to your inbox:

```text
APPROVAL — worker … wants to run Bash: … reqId
```

Answer with `hive ctl approve <reqId> allow|deny|always|never`. `always`/`never` are
remembered per worker+tool; on timeout or absent supervisor the prompt falls back to the
human. Only claude and kiro broker; pi is refused (no permission system).

## Browser

Opt in via Settings, then a spawned agent can drive the visible Browser tile over CDP
via the `hive-browser` skill (`agent-browser` CLI): navigate, click, fill, screenshot
the page you are watching. No hidden browser is started; the agent checks
`$HIVEMIND_BROWSER_TARGETS` and reports if the bridge is off or no tile is open.
