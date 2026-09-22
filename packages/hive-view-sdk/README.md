# @hivemind/view-sdk

Write a hivemind workspace view as a sandboxed plugin. A view is a directory:

```
hivemind-view.json   { "id": "@you/queue", "name": "Queue", "version": "0.1.0", "entry": "index.html", "permissions": [] }
index.html           your bundled page (or point `entry` at a .js module)
```

Start one with `hive views new <name>`; install it with `hive views install <dir>` and it
appears in the app's view switcher.
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

Protocol 1.3 adds, with no permission, what the host knows about time and activity. Check
`hm.hello.features` first — an older app serves an older SDK without these methods:

```ts
const has = new Set(hm.hello.features ?? []);
hm.subscribeStatus(tileId, (status, info) => { /* info.since: when it began; info.exact false → "≥" */ });
hm.onEvents(["turn", "needsInput", "tileClosed"], (e) => {}, { replaySince: lastSeen }); // ids, kinds, times
hm.onCustom("ci.*", (e) => {});                   // from `hive ctl view emit ci.build '{"state":"failed"}'`
hm.activity(tileId, (level) => {});               // 0–3, ≤ 4/s, nothing while hidden — never a byte count
hm.onPresence(({ state }) => {});                 // active | idle | away
const day = await hm.history("2026-09-23");       // per-tile status intervals, turns, gaps
const outcome = await hm.share(pngBuffer);        // the host asks the user: copied | saved | cancelled
```

`closeTile` needs `"permissions": ["workspace:close"]`; `spawnTile` / `spawnVis` /
`spawnClaude` / `addFrame` / `spawnAgent` need `"workspace:spawn"`; `renameTile` /
`openFolder` need `"workspace:edit"`. Unknown permissions are refused at install. Protocol details: `src/protocol.ts`; complete views: `views/` in
[the published plugins](https://github.com/dip497/hivemind-plugins) — `queue` (a list with a
docked terminal), `tiled` (every terminal of a frame laid out as live panes) and `board` (drag,
keyboard moves, a persisted layout).

This is not an npm package. The app builds it into itself and serves it to every view at
`/__sdk.js`, with an import map that resolves `@hivemind/view-sdk` there — so a view leaves it
out of its bundle and always gets the SDK of the app it runs in. `hive views new` gives a view
this source as its types.
