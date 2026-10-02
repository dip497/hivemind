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

`setSurfaceRects` places host-owned tools in your view (a tile's live terminal, where the
screen places them: `hm.supports("surfaces")`, protocol 1.6; a phone's app draws its own terminal
over your view there); `onReveal` answers focus requests; `setLayout` saves up to 64 KB per repository. Canvas/WebGL views can use
`createInvalidator` to coalesce drawing and pause while hidden.


The hello/structure payload includes the resolved palette (`applyThemeVars`), so chrome
can follow the user's theme.

### Machines

A frame whose folder is on another computer carries where it runs (protocol 1.1):

```ts
hm.on("structure", ({ frames }) => {
  for (const f of frames) {
    if (f.machine) draw(f.id, `${f.machine.name} · ${f.machine.state}`); // e.g. "build-box · online"
  }
});
```

`machine` is `{ name, state, rttMs? }`. `state` is `online` (with `rttMs` once measured),
`connecting`, `reconnecting`, `offline`, `attention` (someone has to log in), `no-hive`
(terminals there stop if the connection drops) or `idle`. It changes live — a new `structure`
arrives — and a local frame has no `machine`. Show it wherever your view shows the frame:
which computer the work is on is what a person needs to see.

### Time, events, activity and history

A newer app (view protocol 1.3) also tells a view what it knows about time and work, with no
permission. Check `hm.hello.features` before using any of it — an older app serves an older SDK
that doesn't have these methods:

```ts
const has = new Set(hm.hello.features ?? []);

hm.subscribeStatus(tileId, (status, info) => {
  // info.since: when this status began. info.exact === false: the app found it already there — show "≥".
});
hm.onEvents(["turn", "needsInput", "tileClosed"], (e) => { /* ids, kinds and times */ });
hm.activity(tileId, (level) => { /* 0 quiet … 3 heavy, at most 4 a second, nothing while hidden */ });
hm.onPresence(({ state }) => { /* active, idle, away */ });
const day = await hm.history("2026-09-23");   // per-tile status intervals, even for a day your view wasn't open
const outcome = await hm.share(png);          // the app shows the image and asks: copied, saved or cancelled
```

Your own scripts can talk to the view too. A git hook or a CI wrapper runs

```bash
hive ctl view emit ci.build '{"frame":"payments","state":"failed"}'
```

and a view that asked with `hm.onCustom("ci.*", cb)` gets it. With no view listening, the event
waits an hour for one that asks with `replaySince`. Treat the payload as text from any program
on your machine: show it, never run it.

Nothing here carries what a terminal shows: output is a level, never text or a count, and events
carry ids and times, never what an agent wrote.

### Agents

View protocol 1.4 lets a view see and drive the agents. Check the same `hm.hello.features`:

```ts
hm.subscribeStatus(tileId, (status, info) => {
  // info.agent: state (idle, working, waiting, done, failed, interrupted, limited, exited),
  // waitingFor (permission, question, plan, approval), subagents, background, compacting
});
const agents = await hm.agents();                   // installed agents: turns, resumes, sessions
const past = await hm.sessions("claude", frameId);  // the frame's folder: { id, updated, prompt }
hm.commands.spawnAgent("claude", frameId, { resume: past[0].id });
const outcome = await hm.prompt(tileId, "run the tests"); // sent or cancelled — the user decides
```

`prompt` is the user's own first line of that session; a title the agent wrote is never sent.
Every prompt a view writes opens a dialog in the app showing the full text, with Cancel focused;
after three cancels the view's prompts are declined until it's reloaded. Text with control, bidi
or zero-width characters is refused. A view never reads an agent's replies and never answers its
permission prompts.

### People and devices

View protocol 1.5 tells a view who else is in a shared workspace, and what it is shown on:

```ts
if (hm.supports("participants")) hm.onParticipants((people) => {
  // [{ id, person, name, color, cursor: { tileId } | null, selection: [tileId | frameId] }]
});
if (hm.device.compact) { /* a phone's screen: one column */ }
if (hm.device.touch) { /* a finger: give what it taps room */ }
```

A view that lays itself out for a phone says so in its manifest, `"phone": true`: only those are
offered on the person's phone. There its host runs on their computer, and the view may do what
the phone may: start and close agents (the phone asks its own lock first), but not rename tiles. A
phone's screen places live terminal surfaces only where it says it does (`hm.supports("surfaces")`),
and has no folder picker or share sheet, and starts no tile but an agent's: what asks for them is
refused (`UNSUPPORTED`). Give a page of your own `<meta name="viewport" content="width=device-width,
initial-scale=1">` (the page made for a script entry has it): without one, iOS lays the page out
980 pixels wide. On iOS a view's page is not a secure context (it is served on the app's own
scheme), so `crypto.subtle` and `crypto.randomUUID` are not there; the SDK needs neither.

`cursor` is the tile someone's pointer is over, `selection` what they selected, both only of the
view's own tiles and frames; the person at the view is never in the list. A view tests without the
app against `fakeHost()` from `@hivemind/view-sdk/testing` (it comes with `hive views new`): it
greets the view as the app does, and says what the app would refuse, and why.

## Permissions

Declared in the manifest, refused at install if unknown:
`workspace:close` → `closeTile`; `workspace:spawn` → `spawnTile` / `spawnVis` /
`spawnClaude` / `addFrame` / `spawnAgent`; `workspace:edit` → `renameTile` / `openFolder`;
`workspace:prompt` → `prompt` and `spawnAgent` with a `prompt`; `workspace:sessions` →
`sessions` and `spawnAgent` with `resume`. Selection and focus need none.

`spawnAgent(agent, frameId, { prompt?, name?, resume? })` starts an agent by its catalog id (`null` is
the user's default); a `prompt` becomes its first message once the user sends it. An id that isn't installed is
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
