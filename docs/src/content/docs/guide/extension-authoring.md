---
title: Extension authoring
description: Build and install a workspace view.
---

**Development preview** — community views and `@hivemind/view-sdk` are on the
unreleased development line. The SDK is consumed as TypeScript source in the monorepo
(not yet on npm); the protocol is versioned (`PROTOCOL_VERSION`).

## Package

```text
myview/
  hivemind-view.json   { "id": "myview", "name": "My View", "version": "0.1.0",
                         "entry": "index.html", "protocol": 1, "permissions": [] }
  index.html           bundled page (or entry points at a .js module)
```

Install with `hive views install <dir>` (validates the manifest, copies to
`$XDG_CONFIG_HOME/hivemind/views/<id>`); `hive views list` reports load errors. The
in-app path is Settings ▸ Plugins ▸ Installed → Install from folder, which shows a review step
(manifest, permissions, replaced version) before installing — also preview.

## Sandbox

The page runs in a sandboxed iframe on its own `hm-view://<id>` origin with a strict
CSP: no `window.hive`, no node, no network, no inline scripts. All workspace access is
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

Bundle this module as your entry. For a complete view with live docking, name updates,
status subscriptions, and saved layout, start from `examples/views/tiled` — the smallest of the three examples.

`setSurfaceRects` places host-owned tools in your view; `onReveal` answers focus
requests; `setLayout` saves up to 64 KB per repository. Canvas/WebGL views can use
`createInvalidator` to coalesce drawing and pause while hidden.


The hello/structure payload includes the resolved palette (`applyThemeVars`), so chrome
can follow the user's theme.

## Permissions

Declared in the manifest, refused at install if unknown:
`workspace:close` → `closeTile`; `workspace:spawn` → `spawnTile` / `spawnVis` /
`spawnClaude` / `addFrame`. Selection and focus need none.

## Rules

- Treat surface slots as loans: the host mounts tile bodies once; you position them.
- Render on change: subscribe per tile for status, coalesce draws, stop work while
  `document.hidden`.
- Keep the entry bundle small; heavy libraries load inside your iframe.
- Store camera/placements via `setLayout`; version your blob yourself.
- A disabled plugin recovers from its layout blob on next mount.

Reference implementations: `examples/views/tiled` (surfaces and layout), `queue` (a list, a docked
terminal and a WebGL empty state) and `board` (drag, keyboard moves, persisted layout) — copy
the one closest to what you are building. Protocol types: `packages/hive-view-sdk/src/protocol.ts`.
