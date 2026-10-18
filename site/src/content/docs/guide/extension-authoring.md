---
title: Write a view
description: Build a view that draws the workspace your way, with the view SDK.
---

A view is a small web page that draws the workspace: frames, tiles, agents and their status. It
runs in a sandbox and reads everything through `@hivemind/view-sdk`.

## Start one

```bash
hive views new pulse          # ./pulse, id @<your GitHub login>/pulse
cd pulse && npm install
npm run dev                   # builds to dist/
hive views install dist
```

```text
pulse/
  hivemind-view.json   { "id": "@you/pulse", "name": "Pulse", "version": "0.1.0",
                         "entry": "index.html", "protocol": 1, "permissions": [] }
  index.html           loads ./main.js
  src/main.ts          your view
  dist/                what you install and publish
```

The app serves the SDK to every view, so your bundle leaves it out and stays small. Hand
`PROMPT.md` to a coding agent and it can build the view without reading Hivemind's source.

## The first lines

```ts
import { connect, applyThemeVars } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);                       // follow the user's theme

hm.on("structure", ({ frames, tiles }) => {
  document.body.replaceChildren(...tiles.map((tile) => {
    const b = document.createElement("button");
    b.textContent = tile.name;
    b.onclick = () => hm.commands.selectTile(tile.id);
    return b;
  }));
});
```

`structure` comes again whenever frames or tiles change. Each tile carries its `icon` (an SVG in
`currentColor`) and its `agent`; each frame its `folder`, `branch`, `parentId` (a worktree under
its project) and `machine` when it runs elsewhere.

## What a view can use

Check `hm.supports("<feature>")` before using a newer one.

| Need | Call |
|---|---|
| Put live terminals in your layout | `hm.setSurfaceRects(...)` (`surfaces`) |
| Save your layout (64 KB, per workspace) | `hm.setLayout(blob)` |
| An agent's status as it changes | `hm.subscribeStatus(tileId, (status, info) => …)` |
| What happens: turns, waits, closes | `hm.onEvents(["turn", "needsInput"], cb)` |
| How busy a terminal is (0 to 3) | `hm.activity(tileId, cb)` |
| A day's history per tile | `await hm.history("2026-09-23")` |
| Installed agents, past sessions | `await hm.agents()`, `await hm.sessions("claude", frameId)` |
| Start an agent | `hm.commands.spawnAgent(agent, frameId, { prompt, resume })` |
| Suggest a prompt (the user confirms) | `await hm.prompt(tileId, "run the tests")` |
| Who else is here | `hm.onParticipants(cb)` (`participants`) |
| The board's widgets | `hm.onWidgets(cb)`, `hm.pressWidget(id, action)` (`widgets`) |
| Issues | `hm.onIssues(cb)`, `hm.issues.read(id)`, `create`, `update`, … (`issues`) |
| Its settings | `hm.settings`, `hm.on("settings", cb)` (`settings`) |
| Messages from your scripts | `hm.onCustom("ci.*", cb)`, sent by `hive ctl view emit ci.build '{…}'` |

A view never reads an agent's replies or terminal text, and never answers its permission prompts.
Every prompt a view writes opens a dialog showing the full text, with Cancel focused.

## Permissions

Declared in the manifest; an unknown one is refused at install. Selection and focus need none.

| Permission | Allows |
|---|---|
| `workspace:spawn` | start tiles, agents and frames |
| `workspace:close` | close tiles |
| `workspace:edit` | rename tiles, pick a frame's folder |
| `workspace:prompt` | `prompt`, and `spawnAgent` with a prompt |
| `workspace:sessions` | `sessions`, and `spawnAgent` with `resume` |
| `workspace:widgets` | press and click widgets |
| `workspace:issues` | read and change issues |

## Manifest options

| Field | Does |
|---|---|
| `"settings"` | fields the app draws on the view's Settings page: `boolean`, `number`, `text`, `choice` |
| `"commands"` | what an agent can run in it (`hm.onCommand(name, handler)`), optionally with `"keys": "mod+alt+k"` |
| `"toolbar"` | `"top"`, `"bottom"` (default), `"hidden"` or `"off"` |
| `"layout": "personal"` | keep the layout per person instead of shared |
| `"layers": true` | show the app's Layers panel beside the view |
| `"phone": true` | offer it on the phone page; use `hm.device.compact` and `hm.device.touch` |
| `"category"` | where it is grouped in the Add menu and on HiveHub |

## The sandbox

The page runs on its own `hm-view://<id>` origin with a strict content policy: no `window.hive`,
no Node, no network, no inline scripts. Malformed messages, floods or runaway CPU switch it off for
the session and return the user to the canvas.

- Name your files relatively (`./main.js`): in a browser tab the app serves views under a path.
- Draw on change, and stop work while `document.hidden`.
- Test without the app with `fakeHost()` from `@hivemind/view-sdk/testing`.

## Install and publish

```bash
hive views install dist
hivehub publish dist
```

Examples: [`examples/views/agent-board`](https://github.com/dip497/hivemind/tree/main/examples/views/agent-board)
(saved layout, agent commands) and `views/widgets` in
[the published plugins](https://github.com/dip497/hivemind-plugins).
