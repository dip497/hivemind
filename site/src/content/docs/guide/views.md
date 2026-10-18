---
title: Views
description: How the workspace is drawn, as Canvas, Windows, or a view you install.
---

A view decides how the workspace looks. It never decides what runs: switching views keeps every
terminal, agent and unsaved edit.

Switch with ⌘E (Ctrl+E), the toolbar's view switch, or **Show as** in the Layers panel's title menu.

## The two built-in views

| View | What it is |
|---|---|
| **Canvas** | An endless board. Frames are coloured areas; tiles sit inside them. |
| **Windows** | Tiles as tabs in panes you split, with the Layers panel beside them. Each person keeps their own arrangement. |

Keys in Windows (⌘ for Ctrl on a Mac; they work in a terminal too):

| Keys | Do |
|---|---|
| Ctrl+\\ / Ctrl+Shift+\\ | split right / down |
| Ctrl+Alt+arrows | move between panes |
| Ctrl+Shift+Enter | show the pane alone, or bring the others back |

Drag a tab onto another pane, or onto a pane's edge to split. An agent can do the same with
`hive ctl plugin call windows split-right` (also `split-down`, `focus-left`, `maximize`,
`close-pane`, `unsplit`).

A Browser tile reloads its page once per switch: tabs and history stay, scroll position does not.

## Install a view

```bash
hive views install @someone/their-view   # from HiveHub
hive views install ./my-view/dist        # from a folder
hive views list                          # what loads, and why not
hive views remove @someone/their-view
```

Or **Settings ▸ Plugins** → **HiveHub**. A view runs in a sandbox: no files, no network. It sees
only what its permissions allow, and the app switches it off for the session if it misbehaves.

Examples in the repository's `examples/views`: `constellation`, `timeline`, `agents-by-state`,
`workspace-map`. To write your own: [Write a view](../extension-authoring/).

## Toolbar

The toolbar sits over the active view. Each view's page in **Settings ▸ Plugins** sets
**Toolbar → Display** (Automatic, Top, Bottom, Collapsed or Off) and its buttons
(**Customize actions**). With no toolbar, Settings is at the foot of the Layers panel.
