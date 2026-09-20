---
title: Views
description: Workspace views and their current limitations.
---

⌘E or the Settings ▸ Views overview switches how the workspace is shown. The workspace runtime owns
frames, tiles, and sessions; a view only arranges them.

## Built-in views

- **Canvas** — infinite board; frames as coloured zones; Layers rail on ⌘L; per-frame
  Columns / Rows / Grid arrange.
- **Windows** — one tab per tile; minimized tabs; the active tab follows tile selection
  from any source (click, spawn, `hive ctl focus`).

Everything else is a plugin you install or write. Nothing beyond these two ships in the
box, and neither of them is privileged: they speak the same protocol yours will.

<figure>
  <img src="../../shots/view-canvas.webp" alt="Canvas: frames as coloured zones on an infinite board, tiles placed inside them." />
  <figcaption>Canvas — frames as zones, tiles placed where you put them</figcaption>
</figure>

## The three example views

Same workspace, same three agents, three arrangements. Each one was built for a different
kind of day.

<figure>
  <img src="../../shots/view-queue.webp" alt="Queue: agents in a list grouped by status, the selected agent's terminal docked beside it." />
  <figcaption>Queue — for running many agents: sorted by who needs you</figcaption>
</figure>

<figure>
  <img src="../../shots/view-tiled.webp" alt="Tiled: every terminal in a frame laid out as live panes with frame tabs above." />
  <figcaption>Tiled — for the terminal native: every session visible at once</figcaption>
</figure>

<figure>
  <img src="../../shots/view-board.webp" alt="Board: sessions as cards in doing, needs you, review and done columns." />
  <figcaption>Board — for the lead: cards moving doing → review → done</figcaption>
</figure>

The terminals in those shots are live: a view asks the host for a rectangle, and the host
places the real tile there. Nothing is re-rendered or mirrored.

## Switch behaviour and limits

Tile bodies are mounted once by a shared tile host and lent to the active view, so
switching preserves local terminal sessions, unsaved editor buffers, and browser tabs.
Verified limits:

- A browser tile's page reloads once per view switch (Chromium re-attaches the moved
  `<webview>`); tabs, address, and history survive; page scroll and form state do not.
- Remote PTYs are not affected by switches, but an SSH drop ends them regardless.
- A view that crashes is disabled for the session and you land on the canvas; sessions
  continue.

Each view keeps a versioned layout per repo; unknown view ids fall back to the canvas.

## Community views

Open **Settings → Plugins → Installed → Install from folder**. Review the package and
requested permissions before installing. The same page lets you disable, replace,
or remove a view.

A view is a package — `hivemind-view.json` plus one bundled entry:

```bash
hive views install @dip497/queue          # from HiveHub, every file checked against its hash
hive views install ./my-view/dist           # or from a folder
hive views list        # what will load, and why not
hive views remove @dip497/queue
```

Install/remove ask a running app to rescan. Plugins run in a sandboxed iframe on their
own origin: no filesystem, network, node, or app API. They read workspace structure,
names, per-tile status, and selection through the versioned `@hivemind/view-sdk`
protocol, and can request a surface rect where the host places a real tile (that is how
a live terminal appears inside a plugin scene). Traffic that is malformed, flooded, or
CPU-heavy disables the plugin for the session. Three are published on HiveHub, each built for one kind of person:

- `queue` — for running many agents at once: agents ordered by who needs you, the selected
  one's live terminal docked beside the list.
- `tiled` — for the terminal native: every terminal in a frame laid out as live panes, with
  frame tabs that light when another task needs you.
- `board` — for the lead: sessions as cards moving from doing, to review, to done.

 Authoring: [Extension authoring](../extension-authoring/).

## Chrome in every view

The workspace toolbar (spawn, frame, browser, appearance, update) draws over the active
view — top-centre on canvas, compact elsewhere; its position is configured on each view's
page under Settings ▸ Views. Choose Collapsed to keep a handle or Off to use only your view’s
controls. Settings remains accessible in the app header. A docked tile gets a host bar with name, status, pop-out, and undock.

## Appearance inside views

A terminal docked in a community view renders per the `pluginSurfaces` setting:
`theme` (as on canvas, wallpaper clipped to the slot) or `opaque` (solid terminal
background). Set it in Settings ▸ Appearance or
`hive config set appearance.pluginSurfaces '"opaque"'`.
