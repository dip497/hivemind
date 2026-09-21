---
title: Extension authoring
description: Build and install a workspace view.
---

A view speaks a versioned protocol (`PROTOCOL_VERSION`); a view built for a newer one says so
with `minAppVersion`, and the app refuses rather than half-loads it.

## Start one

```bash
hive views new pulse          # ./pulse, id @<your GitHub login>/pulse
cd pulse && npm install
npm run dev                   # build to dist/, install into the running app
```

There is no SDK package to install. The app serves `@hivemind/view-sdk` to every view, the
same version it speaks, so your bundle leaves it out (`external` in `build.mjs`) and stays a
few kilobytes. `types/view-sdk/` is its source, there for your editor and `tsc`.

```text
pulse/
  hivemind-view.json   { "id": "@you/pulse", "name": "Pulse", "version": "0.1.0",
                         "entry": "index.html", "protocol": 1, "permissions": [] }
  index.html           the page; loads ./main.js as a module
  src/main.ts          your view
  dist/                what you install and publish
```

`hive views install <dir>` validates the manifest and copies it to
`$XDG_CONFIG_HOME/hivemind/views/<id>`; `hive views list` reports load errors. In the app,
Settings ▸ Plugins ▸ Installed → Install from folder shows a review step first.

## Publish

Push the commit, then `hivehub publish dist` (or sign in on HiveHub and name the folder). The
id's scope must be your GitHub login: nobody can publish into someone else's.

## Sandbox

The page runs in a sandboxed iframe on its own `hm-view://<id>` origin with a strict
CSP: no `window.hive`, no node, no network, no inline scripts. `@hivemind/view-sdk` resolves to the app's copy on every page. All workspace access is
over one validated MessagePort. Budget violations — malformed messages, floods, runaway
CPU — disable the plugin for the session and return the user to the canvas.

## Client API (`@hivemind/view-sdk`)

```ts
import { connect, applyThemeVars } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);

hm.on("structure", ({ tiles }) => {
  const buttons = tiles.map((tile) => {
    const button = document.createElement("button");
    button.textContent = tile.name;
    button.onclick = () => hm.commands.selectTile(tile.id);
    return button;
  });
  document.body.replaceChildren(...buttons);
});
```

For a complete view with live docking, name updates, status subscriptions, and saved
layout, read `views/tiled` in [the published plugins](https://github.com/dip497/hivemind-plugins).

`setSurfaceRects` places host-owned tools in your view; `onReveal` answers focus
requests; `setLayout` saves up to 64 KB per repository. Canvas/WebGL views can use
`createInvalidator` to coalesce drawing and pause while hidden.


The hello/structure payload includes the resolved palette (`applyThemeVars`), so chrome
can follow the user's theme.

## Permissions

Declared in the manifest, refused at install if unknown:
`workspace:close` → `closeTile`; `workspace:spawn` → `spawnTile` / `spawnVis` /
`spawnClaude` / `addFrame` / `spawnAgent`; `workspace:edit` → `renameTile` / `openFolder`.
Selection and focus need none.

`spawnAgent(agent, frameId, { prompt?, name? })` starts an agent by its catalog id (`null` is
the user's default) and hands it `prompt` as its first message. An id that isn't installed is
refused. `openFolder(frameId)` asks the user to pick the frame's folder; the view never sees a path.

`structure` also tells you how the workspace is wired: each tile's `agent`, each frame's
`parentId` (a worktree nested under its repo), `branch` and `folder: { name, kind }`, and
`links: { pipes, spawns }` — which agent feeds which, and which agent started which.

## Rules

- Treat surface slots as loans: the host mounts tile bodies once; you position them.
- Render on change: subscribe per tile for status, coalesce draws, stop work while
  `document.hidden`.
- Keep the entry bundle small; heavy libraries load inside your iframe.
- Store camera/placements via `setLayout`; version your blob yourself.
- A disabled plugin recovers from its layout blob on next mount.

Reference implementations, in [the published plugins](https://github.com/dip497/hivemind-plugins):
`views/tiled` (surfaces and layout), `queue` (a list, a docked terminal and a WebGL empty state)
and `board` (drag, keyboard moves, persisted layout). Protocol types: `types/view-sdk/protocol.ts`
in your view.
