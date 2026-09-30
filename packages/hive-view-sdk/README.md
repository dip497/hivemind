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

Protocol 1.4 adds the agents themselves (`has.has("agentStatus")` and friends):

```ts
hm.subscribeStatus(tileId, (status, info) => { /* info.agent: { state, waitingFor, subagents, background, compacting } */ });
const agents = await hm.agents();                 // installed agents and what each supports
const past = await hm.sessions("claude", frameId); // "workspace:sessions": that folder's sessions, newest first
hm.commands.spawnAgent("claude", frameId, { resume: past[0].id }); // continue one
await hm.prompt(tileId, "run the tests");         // "workspace:prompt": the user reads it and sends or cancels
```

Protocol 1.5 adds the people a workspace is shared with, and the device a view is on
(`has.has("participants")`; `hm.device` is always there):

```ts
hm.onParticipants((people) => ring(people));     // { id, person, name, color, cursor: { tileId } | null, selection }
if (hm.device.compact) oneColumn();               // a phone's screen; hm.device.touch: a finger, give it room
```

`cursor` is the tile someone's pointer is over and `selection` what they selected, only ever of the
view's own tiles and frames; the person at the view is never among them. A surface rect goes to the
host once a `structure` has named its tile (a docked tile from a saved layout that is gone stays
held back), and leaves when one no longer does.

Test a view without the app against the fake host in `@hivemind/view-sdk/testing`: it greets the
view as the app does, checks what the view sends by the app's rules and says why it would refuse
the rest.

```ts
import { fakeHost } from "@hivemind/view-sdk/testing";
const host = fakeHost({ capabilities: ["workspace:spawn"], device: { touch: true, compact: true } });
const hm = await host.connect();                  // or host.handshake(window) before the page's own connect()
host.send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
await host.settle();
host.commands; host.rects; host.refused;          // what the app would run, show, and refuse (and why)
```

`closeTile` needs `"permissions": ["workspace:close"]`; `spawnTile` / `spawnVis` /
`spawnClaude` / `addFrame` / `spawnAgent` need `"workspace:spawn"`; `renameTile` /
`openFolder` need `"workspace:edit"`; `prompt`, and `spawnAgent` with a `prompt`, need
`"workspace:prompt"`; `sessions`, and `spawnAgent` with `resume`, need `"workspace:sessions"`. Unknown permissions are refused at install. Protocol details: `src/protocol.ts`; complete views: `views/` in
[the published plugins](https://github.com/dip497/hivemind-plugins) — `queue` (a list with a
docked terminal), `tiled` (every terminal of a frame laid out as live panes) and `board` (drag,
keyboard moves, a persisted layout).

This is not an npm package. The app builds it into itself and serves it to every view at
`/__sdk.js`, with an import map that resolves `@hivemind/view-sdk` there — so a view leaves it
out of its bundle and always gets the SDK of the app it runs in. `hive views new` gives a view
this source as its types.
