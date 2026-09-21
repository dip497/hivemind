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
| Remote SSH | A directory on a saved machine, as `ssh://user@host:port/abs/path`. Terminals run in `hive` on that machine and keep running when the connection drops or the app closes; the editor and diff work over the same connection. One ssh connection per machine, using your keys, agent and `~/.ssh/config` (or a password kept in the OS keychain). |

Remote frames are path-keyed: the `ssh://` URI is the workspace path, so tiles go
remote without per-tile changes (`docs/design/remote-frames.md`).

## Machines

Machines live in the Layers rail, one heading per computer — **This computer** first — with
its link (round trip, or why it is down), how many agents there need you, and its frames under
it. From a machine's heading:

- **+** opens a folder there as a new frame.
- **Retry** skips the reconnect wait (shown while it is down).
- **⋯ → Turn off** drops the connection. Its terminals keep running on the machine and their
  tiles keep their screen; **Turn on** (there, or on any of its tiles) reconnects them.
- **⋯ → Manage machines…** adds, edits and removes. **Edit** changes the name, address,
  user or port; a new address is reached before it is saved, and the frames on the machine
  move with it. **Remove** says what uses the machine first and leaves its terminals running
  unless you tick “also end”.

The list is the same one `hive machine` edits in a terminal.

## The `.hivemind/` directory

```text
.hivemind/
├── issues/<ID>.md   one file per issue: frontmatter, description,
│                    acceptance criteria, activity log
├── cycles/          sprint definitions
├── config.yaml      prefix, next id, detected agent CLIs
└── .agent.md        regenerated summary of active issues (gitignored)
```

An issue moves along one track, and `cancelled` is the way off it. Activity rows are signed by
the human or the agent that wrote them.

<figure>
<svg viewBox="0 0 700 118" role="img" aria-label="An issue moves backlog to todo to in_progress to in_review to done; cancelled leaves the track from any state.">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="var(--sl-font-mono)" font-size="11.5" fill="currentColor" stroke="currentColor">
    <rect x="1" y="16" width="104" height="30" rx="5" fill="none" stroke-opacity=".4"/>
    <text x="53" y="35" text-anchor="middle" stroke="none" opacity=".7">backlog</text>
    <rect x="149" y="16" width="104" height="30" rx="5" fill="none" stroke-opacity=".4"/>
    <text x="201" y="35" text-anchor="middle" stroke="none" opacity=".7">todo</text>
    <rect x="297" y="16" width="104" height="30" rx="5" fill="none" stroke="var(--hm-working)" stroke-opacity=".8"/>
    <text x="349" y="35" text-anchor="middle" stroke="none">in_progress</text>
    <rect x="445" y="16" width="104" height="30" rx="5" fill="none" stroke="var(--hm-attention)" stroke-opacity=".8"/>
    <text x="497" y="35" text-anchor="middle" stroke="none">in_review</text>
    <rect x="593" y="16" width="104" height="30" rx="5" fill="none" stroke="var(--hm-done)" stroke-opacity=".8"/>
    <text x="645" y="35" text-anchor="middle" stroke="none">done</text>
    <g fill="none" stroke-opacity=".55" marker-end="url(#ar2)">
      <path d="M107 31 H145"/><path d="M255 31 H293"/><path d="M403 31 H441"/><path d="M551 31 H589"/>
      <path d="M349 50 V78 H641" stroke-dasharray="4 4"/>
    </g>
    <text x="645" y="96" text-anchor="middle" stroke="none" opacity=".7">cancelled</text>
  </g>
</svg>
<figcaption>One track forward; cancelled is the only way off it, from any state</figcaption>
</figure>

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

Limits: a machine without `hive` (Manage machines → Install hive) runs plain ssh
terminals, which end when the connection drops. Issues and `hive ctl` read this computer's
`.hivemind/` only. Screen content replays from disk after a daemon restart or reboot.
