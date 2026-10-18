---
title: Views
description: How the workspace is drawn — Canvas, Windows, or a view you install.
---

A view arranges the workspace on screen: frames, tiles, names and live status. The runtime owns
frames, tiles and sessions; a view never decides what runs. A terminal inside a view is the real
one: the view asks for a rectangle and the app places the live tile there.

Switch views with ⌘E (Ctrl+E), the toolbar's view switch, **Show as** in the Layers panel's
title menu, or **Use this view** on a view's page in **Settings ▸ Plugins**.

## Views that come with the app

| | |
|---|---|
| **Canvas** | An infinite board. Frames are coloured zones; a frame's ⋯ menu arranges its tiles as Columns, Rows or Grid. |
| **Windows** | Tiles as tabs in panes you split, with the Layers panel beside them. No toolbar. Each person keeps their own arrangement. |

<figure>
  <img src="../../shots/view-canvas.webp" alt="Canvas: frames as coloured zones on an infinite board, tiles placed inside them." />
  <figcaption>Canvas — frames as zones, tiles placed where you put them</figcaption>
</figure>

In Windows:

| Keys | |
|---|---|
| Ctrl+\\ / Ctrl+Shift+\\ | split the pane right / down |
| Ctrl+Alt+arrows | move between panes |
| Ctrl+Shift+Enter | show the pane alone, or bring the others back |

On a Mac, ⌘ for Ctrl. The keys work with a terminal focused. Drag a tab onto another pane's tabs
to move it, or onto a pane's edge to split it; double-click a divider to make the panes equal.
An agent can do the same: `hive ctl plugin call windows split-right` (and `split-down`,
`focus-left`, `maximize`, `close-pane`, `unsplit` …).

Windows is a view package like any other (`apps/desktop/views/windows`): install a view with
the id `windows` and yours replaces it.

## What a switch keeps

Each tile is mounted once and lent to the active view, so a switch keeps terminal sessions,
unsaved Code tile edits and browser tabs. Limits:

- A Browser tile reloads its page once per switch; tabs, address and history survive, page
  scroll and form state do not.
- A view that crashes is switched off for the session and you land on the canvas; sessions
  continue.

Each view keeps its layout per workspace, shared with everyone in it, unless its manifest says
`"layout": "personal"` (Windows does), which keeps it on your computer.

## Install a view

```bash
hive views install @someone/their-view     # from HiveHub, every file checked against its hash
hive views install ./my-view/dist          # or from a folder
hive views list                            # what will load, and why not
hive views remove @someone/their-view
```

Or **Settings ▸ Plugins**: the **HiveHub** tab, or **Add → Add a view from a folder**. Review the
permissions it asks for. The view's page there switches it off or removes it.

A view runs in a sandboxed frame on its own origin: no files, network or app API. It reads the
workspace through `@hivemind/view-sdk` and does only what its permissions allow. Traffic that is
malformed, flooded or CPU-heavy switches it off for the session.

In `examples/views` of the repository: `constellation` (your agents in 3D, drawn with three.js
shipped in the view's folder), `timeline` (today's work per agent), `agents-by-state` (a board by
what each agent is doing) and `workspace-map` (frames, worktrees, agents and issues).

## Write one

```bash
hive views new my-view
```

The starter runs as it is and includes `PROMPT.md`: the whole view API, the rules of the sandbox
and what "done" means. Write what you want at the top, hand the file to a coding agent, and it can
build the view without reading the Hivemind source. **Make your own…** in the Add menu or
**Settings ▸ Plugins** writes the prompt for you. The API: [Extension authoring](../extension-authoring/).

## Toolbar and appearance

The toolbar (agent, frame, browser, Add, theme, the view switch, updates and Settings) draws over
the active view. A view's manifest sets where (`"toolbar": "top" | "bottom" | "hidden" | "off"`);
**Settings ▸ Plugins**, the view's page, **Toolbar → Display** overrides it. Where there is no
toolbar, Settings is at the foot of the Layers panel or in the window's top-right corner.

A terminal docked in an installed view follows `pluginSurfaces`: `theme` (as on the canvas,
wallpaper clipped to the slot) or `opaque` (solid). Set it in **Settings ▸ Appearance** or with
`hive config set appearance.pluginSurfaces '"opaque"'`.
