---
title: Workspaces
description: Repositories, worktrees, SSH, and saved layouts.
---

## Frames

One canvas per project. **Frames** are named zones on it, each bound to a directory:

| Binding | Behaviour |
|---|---|
| Local repo | Default; tiles run in that directory. |
| Git worktree | A nested sub-frame scoped to one branch (frame header → **worktree**). Arrange a frame's tiles and worktrees as Columns / Rows / Grid. |
| Remote SSH | A directory as `ssh://user@host:port/abs/path`. Terminals are PTYs on the host, the editor reads/writes over SFTP, diff/status run `git` remotely. One pooled `ssh2` connection per host; agent, key, or password auth; TOFU host keys. |

Remote frames are path-keyed: the `ssh://` URI is the workspace path, so tiles go
remote without per-tile changes (`docs/design/remote-frames.md`).

## The `.hivemind/` directory

```text
.hivemind/
├── issues/<ID>.md   one file per issue: frontmatter, description,
│                    acceptance criteria, activity log
├── cycles/          sprint definitions
├── config.yaml      prefix, next id, detected agent CLIs
└── .agent.md        regenerated summary of active issues (gitignored)
```

States: `backlog → todo → in_progress → in_review → done`, plus `cancelled`. Activity
rows are signed by the human or the agent that wrote them.

## Cross-repo work

Workspaces register in a per-user registry (prefix → `.hivemind` root):

```bash
hive workspace register
hive workspace list
```

Once registered, ids resolve across repos:

```bash
hive relate MYP-3 OPS-7 --type blocks   # reciprocal link written on both issues
hive move MYP-3 OPS                     # transfer (refuses issues with sub-issues)
hive move MYP-3 OPS --copy              # copy; source kept, ends linked
```

Link types: `relates`, `blocks`, `blocked-by`, `duplicates`, `parent-of`, `child-of`,
`moved-to`, `moved-from`. Hierarchy inside one repo uses parent/child:
`hive new "…" --parent MYP-3` or `hive task MYP-3 add "…"` (sub-ids `MYP-3.1`, …).

## Parallel agents

Spawn one agent per frame (`2` or the frame's **+**). Typical setups: a worktree per
branch with an agent in each, or a frame bound to a remote host running agents there.
Each agent is scoped to its frame's directory and issues.

## Persistence and limits

Local PTYs survive window close via a detached daemon; agent conversations resume after
daemon restarts or reboots per the runtime's resume capability (claude/kiro resume their
own session, codex/droid the newest session for the directory, opencode none). Closing a
tile (`×`) kills it. Layout — frames, positions, viewport, editor tabs — persists per
repo.

Limits: remote PTYs run in the app process, so an SSH drop ends them; the daemon cannot
reattach to a remote session. Screen content replays from disk after a daemon restart or
reboot.
