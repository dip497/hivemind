# @hivemind/view-sdk

Write a hivemind workspace view as a sandboxed plugin. A view is a directory:

```
hivemind-view.json   { "id": "orbit", "name": "Orbit", "version": "0.1.0", "entry": "index.html", "permissions": [] }
index.html           your bundled page (or point `entry` at a .js module)
```

Install it with `hive views install <dir>`; it appears in the app's view switcher.
The page runs in a sandboxed iframe on its own origin — no filesystem, network,
or app API — and talks to hivemind through this client:

```ts
import { connect, createInvalidator } from "@hivemind/view-sdk";

const hm = await connect();                       // resolves after the host's hello
const { invalidate } = createInvalidator(hm, draw); // one frame per burst, none while hidden

hm.on("structure", ({ frames, tiles }) => { /* frames have #rrggbb colours; tiles have frameId + name */ invalidate(); });
hm.on("names", ({ names }) => { /* renames / agent titles, no structural change */ });
hm.on("selection", ({ tileId, fresh }) => { /* fresh = changed since you mounted */ });
hm.subscribeStatus(tileId, (status) => { /* idle | working | blocked | exited | unknown */ invalidate(); });

hm.commands.selectTile(tileId);                   // the WorkspaceCommands vocabulary, validated by the host
hm.setSurfaceRects([{ tileId, x, y, w, h }]);     // a LIVE terminal appears in this rect (the host owns it)
hm.onReveal((tileId) => rectOf(tileId));          // the host asks "where is this tile?"
hm.setLayout({ camera });                         // ≤ 64 KB, persisted under your id, back in hm.hello.layout
```

`closeTile` needs `"permissions": ["workspace:close"]`; `spawnTile` / `spawnVis` /
`spawnClaude` / `addFrame` need `"workspace:spawn"`. Unknown permissions are refused
at install. Protocol details: `src/protocol.ts`; a complete example:
`examples/views/orbit` in the hivemind repo.

Status: consumed as TypeScript source inside the hivemind monorepo (workspace
dependency). Publishing to npm is not set up yet — a `dist/` build and a `files`
list are the missing pieces; the protocol is versioned (`PROTOCOL_VERSION`) so a
published package can pin what it speaks.
