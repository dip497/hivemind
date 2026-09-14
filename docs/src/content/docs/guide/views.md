---
title: Views
description: Workspace views and their current limitations.
---

**Development preview** — views-as-plugins, World, and community views are on the
unreleased development line (post-1.16.0). The canvas is released behaviour.

⌘E or the Settings ▸ Views overview switches how the workspace is shown. The workspace runtime owns
frames, tiles, and sessions; a view only arranges them.

## Built-in views

- **Canvas** — infinite board; frames as coloured zones; Layers rail on ⌘L; per-frame
  Columns / Rows / Grid arrange.
- **Windows** — one tab per tile; minimized tabs; the active tab follows tile selection
  from any source (click, spawn, `hive ctl focus`).
- **World** — a Three.js scene: one island per frame, one block per tile coloured by
  agent status. Clicking a block docks that tile's live terminal beside the scene (real
  input, not a texture); Esc or Shift+Esc undocks; clicking an island flies to it.
  Camera and placements persist per repo.

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
hive views install examples/views/orbit/dist
hive views list        # what will load, and why not
hive views remove orbit
```

Install/remove ask a running app to rescan. Plugins run in a sandboxed iframe on their
own origin: no filesystem, network, node, or app API. They read workspace structure,
names, per-tile status, and selection through the versioned `@hivemind/view-sdk`
protocol, and can request a surface rect where the host places a real tile (that is how
a live terminal appears inside a plugin scene). Traffic that is malformed, flooded, or
CPU-heavy disables the plugin for the session. Examples in `examples/views/`: orbit
(2D canvas), office (isometric), solar (three.js). Authoring:
[Extension authoring](../extension-authoring/).

## Chrome in every view

The workspace toolbar (spawn, frame, browser, appearance, update) draws over the active
view — top-centre on canvas, compact elsewhere; its position is configured on each view's
page under Settings ▸ Views. Choose Collapsed to keep a handle or Off to use only your view’s
controls. Settings remains accessible in the app header. A docked tile gets a host bar with name, status, pop-out, and undock.

## Appearance inside views

A terminal docked in World or a community view renders per the `pluginSurfaces` setting:
`theme` (as on canvas, wallpaper clipped to the slot) or `opaque` (solid terminal
background). Set it in Settings ▸ Appearance or
`hive config set appearance.pluginSurfaces '"opaque"'`.
