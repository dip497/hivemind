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
| Machine (ssh) | A directory on a saved machine, as `machine://<machine id>/abs/path`: the frame names the machine, and the machine says where it is. Terminals run in `hive` on that machine and keep running when the connection drops or the app closes; the Code tile works over the same connection. One ssh connection per machine, using your keys, agent and `~/.ssh/config` (or a password kept in the OS keychain). See [Machines](../machines/). |

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

- **+** (or **⋯ → Open folder here…**) opens a folder there as a new frame.
- The refresh button (**Retry now**) skips the reconnect wait while it is down; **⋯ → Check now**
  checks it again.
- **⋯ → Pause** stops this app connecting to it. Nothing on the machine stops: its terminals keep
  running there. **⋯ → Resume** reconnects.
- **⋯ → Manage machines…** adds, edits and removes machines, and installs or updates `hive` on
  one.

The list is the same one `hive machine` edits in a terminal. Adding a machine, what it needs and
what runs there: [Machines](../machines/).

## The `.hivemind/` directory

```text
.hivemind/
├── issues/<ID>.md   one file per issue: frontmatter, description,
│                    acceptance criteria, activity log
│                    (sub-issues under issues/<ID>/<ID>.1.md)
├── config.yaml      prefix, next id, detected agent CLIs
├── review.json      line comments left on a diff (hive review)
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

`hive relate --type` takes `relates`, `blocks`, `blocked-by`, `duplicates`, `parent-of` or
`child-of`; `hive move` writes `moved-to` and `moved-from` itself. Hierarchy inside one repo uses
parent/child: `hive new "…" --parent MYP-3` or `hive task add MYP-3 "…"` (sub-ids `MYP-3.1`, …).

## Parallel agents

Spawn one agent per frame (`2`, or the frame's ⋯ → **New agent ▸**). Typical setups: a worktree per
branch with an agent in each, or a frame on a [machine](../machines/) running agents there.
Each agent is scoped to its frame's directory and issues.

## Persistence and limits

Local PTYs survive window close via a detached daemon. After a daemon restart or a reboot, an
agent whose manifest says it can resume continues its own conversation; one that cannot starts
fresh. Closing a tile (`×`) kills it.

To free memory without losing an agent, put it to sleep: the frame's ⋯ → **Put agents to
sleep**, the tile's menu in the Layers panel, or `hive ctl sleep <tile or frame>`. Its process
ends; its tile keeps its name and shows a black screen with **Resume**. Resuming (or
`hive ctl wake`) continues the same conversation. A busy agent stays awake unless you pass
`--force`. Layout — frames, positions, viewport, open files — persists per
repo. Deleting a frame that holds tiles asks whether to **Keep them** (loose on the canvas) or
close them with it.

Limits: a machine without `hive` (Manage machines → Install hive) runs plain ssh
terminals, which end when the connection drops. Issues and `hive ctl` read this computer's
`.hivemind/` only. Screen content replays from disk after a daemon restart or reboot.
