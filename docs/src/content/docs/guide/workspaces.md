---
title: Workspaces
description: Repositories, worktrees, SSH, and saved layouts.
---

## Frames

One canvas per project. **Frames** are named zones on it, each bound to a directory:

| Binding | Behaviour |
|---|---|
| Local repo | Default; tiles run in that directory. |
| Git worktree | A nested sub-frame scoped to one branch (a frame's ⋯ → **Worktree ▸**). Arrange a frame's tiles and worktrees as Columns / Rows / Grid. |
| Remote SSH | A directory on a saved machine, as `machine://<machine id>/abs/path`: the frame names the machine, and the machine says where it is. Terminals run in `hive` on that machine and keep running when the connection drops or the app closes; the Code tile works over the same connection. One ssh connection per machine, using your keys, agent and `~/.ssh/config` (or a password kept in the OS keychain). |

Remote frames are path-keyed: the `machine://` URI is the workspace path, so tiles go
remote without per-tile changes (`docs/design/remote-frames.md`). A frame on a host no machine is
saved for — one you removed — is `ssh://user@host:port/abs/path` and still runs there; saving a
machine at that address puts the frame on it, as it does for a workspace from before machines had
ids.

## The Layers panel

⌘B (Ctrl+B outside a terminal), or the button in its header, hides it and brings it back. A rail down its left edge picks what it shows: **Tiles**, **Recents** or
**Machines**, with **Plugins** and **Settings** at its foot. Its title is this workspace; its menu
lists every workspace on this computer (with how many agents need you there) to open in this
window, opens a folder or a recent one, joins a shared workspace, and switches views (**Show as**). Its search narrows everything it lists, and its bell
counts the agents that need you and goes to the next.

- **Tiles**: **New agent** (which one, from the agents installed here), **New project** (a folder,
  as a frame on this canvas) and **Add a tool or widget**. Then **Pinned**, then **Projects**: each
  frame with a folder, its worktrees under it, and the tiles in each. Frames with no folder are
  **Groups**; tiles in no frame are **Canvas**. What an agent started (`hive ctl spawn`) is listed
  under it and folds away.
- **Recents**: the past agent sessions of every folder here, newest first, grouped by **agent**,
  **project** or **date** (or not at all) from its heading. Each group folds and shows its newest
  five, with **Show more**. One click resumes a session in its project.
- **Machines**: **New machine**, then this computer and every machine you added, with its link.

Hold **Ctrl** (**⌘** on macOS) and the first nine rows show their number; **Ctrl+1** to **Ctrl+9**
go to that row's tile, counted as the panel lists them, from a terminal too. A frame's **⋮** (or a
right-click) opens its menu, the same one as the **⋯** on its header on the canvas.

- **Pin** a tile from its **⋮** menu (or right-click it, then press **P**): it goes to **Pinned**
  at the top, whatever the panel lists below. **R** renames it, **D** closes it. Hover a row to
  see when it was last active and where it runs.
- A tile that finished something while you looked elsewhere is **unread**: a dot after its name
  until you select it. **U** marks one unread again, or read; the View menu's **Unread** lists only those.
- **Snooze** a tile (30 minutes, 1 hour, 2 hours, tomorrow at 9:00) and it leaves the list for
  **Snoozed** until then. It is back early if it needs you, or when you select it; **Wake now**
  brings it back at once.
- The **View** menu (the tiles' heading, **By project ⌄**) chooses what is listed: **Status** (needs you, working, idle,
  exited), **Last activity** (past hour, today, this week), **Machines**; how it is grouped
  (**Project**, **Machine**, **Date**, **Status**, **Agent** or none) and ordered (canvas order,
  last activity, name). **Reset to defaults** undoes
  it all.

The View menu is yours in every workspace (`hive config set views.layers.groupBy status`). Pins,
folded sections, what you have seen and what you snoozed are yours in this workspace, on this computer: in a shared workspace, no one
else's panel changes.

## Machines

The Layers panel's **Machines** pane lists one heading per computer — **This computer** first — with
its link (round trip, or why it is down), how many agents there need you, and its frames under
it. From a machine's heading:

- **+** opens a folder there as a new frame.
- **Retry** skips the reconnect wait (shown while it is down).
- **⋯ → Turn off** drops the connection. Its terminals keep running on the machine and their
  tiles keep their screen; **Turn on** (there, or on any of its tiles) reconnects them.
- **⋯ → Manage machines…** adds, edits and removes. **Edit** changes the name, address,
  user or port; a new address is reached before it is saved, and the frames on the machine
  move with it (they name the machine, not the address). **Remove** says what uses the machine
  first and leaves its terminals running unless you tick “also end”; its frames go back to its
  address, where they still run, and can be saved as a machine again.

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

```mermaid title="One track forward; cancelled is the way off it, from any state"
flowchart TB
  backlog --> todo --> in_progress --> in_review --> done
  in_progress -.-> cancelled
```

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

Spawn one agent per frame (`2`, or the frame's ⋯ → **New agent ▸**). Typical setups: a worktree per
branch with an agent in each, or a frame bound to a remote host running agents there.
Each agent is scoped to its frame's directory and issues.

## Persistence and limits

Local PTYs survive window close via a detached daemon; agent conversations resume after
daemon restarts or reboots per the runtime's resume capability (claude/kiro resume their
own session, codex/droid the newest session for the directory, opencode none). Closing a
tile (`×`) kills it. Layout — frames, positions, viewport, open files — persists per
repo. Deleting a frame that holds tiles asks whether to **Keep them** (loose on the canvas) or
close them with it.

Limits: a machine without `hive` (Manage machines → Install hive) runs plain ssh
terminals, which end when the connection drops. Issues and `hive ctl` read this computer's
`.hivemind/` only. Screen content replays from disk after a daemon restart or reboot.
