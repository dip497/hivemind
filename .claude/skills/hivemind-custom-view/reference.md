# Protocol v1 reference

One `MessagePort`, plain JSON objects with a `type`. Both sides validate: the host
refuses anything malformed before it touches workspace state, the client drops anything
it does not understand. Source of truth is
`packages/hive-view-sdk/src/protocol.ts` — when this file and that one disagree, that
one wins.

## Host → plugin

| Message | Payload | Notes |
| --- | --- | --- |
| `hello` | `v`, `pluginId`, `capabilities`, `theme`, `layout`, `viewport`, `visible` | Arrives once. `connect()` resolves on it; `layout` is your last `setLayout` blob |
| `structure` | `frames[]`, `tiles[]` | Structural only — membership and current names |
| `names` | `names: Record<id, string>` | Renames and agent titles; nothing structural moved |
| `selection` | `tileId`, `frameId`, `fresh` | `fresh: false` is the selection you arrived with — do not animate to it |
| `status` | `tileId`, `status` | Only for tiles you subscribed to |
| `reveal` | `requestId`, `tileId` | Answer with `revealed` |
| `resize` | `w`, `h` | Your viewport changed |
| `visibility` | `visible` | Draw nothing while false |
| `theme` | `theme` | The user changed appearance |
| `undock` | `tileId` | The tile is **already** released; drop your rect |
| `status` (1.3) | `since?`, `exact?` | When the status began; `exact: false` = a lower bound |
| `events` (1.3) | `events[]`, `replay?` | After `subscribeEvents`; one message per host task |
| `activity` (1.3) | `levels: Record<id, 0..3>` | After `watchActivity`; only changes, ≤ 4/s, none while hidden |
| `presence` (1.3) | `presence {state, since, focused}` | After `subscribePresence`; on change |
| `response` (1.3) | `requestId`, `ok`, `result \| error {code}` | The answer to `request`; codes `UNSUPPORTED`, `BAD_REQUEST`, `BUSY`, `DECLINED`, `INTERNAL` |
| `status` (1.4) | `agent? {state, waitingFor?, subagents, background, compacting, source?}` | On agent tiles; `state`: idle, working, waiting, done, failed, interrupted, limited, exited |

`hello.features` (1.3) lists what the host wired: `since`, `events`, `activity`, `presence`,
`history`, `share`; 1.4 adds `agentStatus`, `agents`, `sessions`, `prompt`. A host that predates
1.3 sends none.

`ViewEvent` kinds: `turn {inferred?, outcome? (1.4): done | failed | interrupted | limited}`, `needsInput {reason: permission | question | review |
approval | input}`, `subagents {active}`, `tileOpened {frameId, tileKind, agent?, spawnedBy?}`,
`tileClosed {lastStatus, failed?}`, `custom {id, name, data, from}`. Every event carries
`seq`, `at` and (except custom) `tileId` — never text an agent wrote.

`ViewFrame` is `{ id, title, color: "#rrggbb" }`. `ViewTile` is
`{ id, frameId: string | null, kind, name }`. Colours arrive resolved — you never
compute one from a theme token yourself.

`ViewStatus` is `"unknown" | "idle" | "working" | "blocked" | "exited"`.

## Plugin → host

| Message | Payload | Notes |
| --- | --- | --- |
| `ready` | `v` | Sent by the SDK for you |
| `command` | `name`, `args[]` | Permission-gated; see below |
| `subscribeStatus` / `unsubscribeStatus` | `tileId` | `subscribeStatus()` handles both ends |
| `surfaceRects` | `rects[]` | ≤ 16. Deduplicated by the client |
| `revealed` | `requestId`, `rect \| null` | The answer to `reveal` |
| `framesDrawn` | `count` | Monotonic, throttled to ~1/s by the SDK |
| `layout` | `data` | ≤ 64 KB, debounced |
| `error` | `message` | Non-fatal, goes to the host log |
| `subscribeEvents` (1.3) | `kinds[]`, `custom?[]`, `replaySince?` | Replaces the previous subscription; ≤ 32 custom names or `name.*` |
| `unsubscribeEvents` (1.3) | — | |
| `watchActivity` (1.3) | `tileIds[]` | The whole watched set, ≤ 256 |
| `subscribePresence` / `unsubscribePresence` (1.3) | — | |
| `request` (1.3) | `requestId`, `name: history \| share`, `args` | `history [{day}]`; `share [{png: ArrayBuffer, suggestedName?}]` — the one non-JSON value |
| `request` (1.4) | `name: agents \| sessions \| prompt` | `agents [{}]` → `{agents}`; `sessions [{agent, frameId}]` → `{sessions: [{id, updated?, prompt?}]}`; `prompt [{tileId, text}]` → `{outcome: sent \| cancelled}` |

Sending a 1.3 message to a host that did not advertise the feature is a refusal, like an
unknown message; the SDK never does.

## Commands and their permissions

| Command | Permission |
| --- | --- |
| `selectTile(id \| null)` | none |
| `selectFrame(id \| null)` | none |
| `focusTile(id, { exact? })` | none |
| `closeTile(id)` | `workspace:close` |
| `spawnTile(kind, frameId \| null)` | `workspace:spawn` |
| `spawnVis("tree" \| "shell" \| "diff" \| "issues")` | `workspace:spawn` |
| `spawnClaude()` | `workspace:spawn` |
| `addFrame()` | `workspace:spawn` |
| `spawnAgent(agentId \| null, frameId \| null, { prompt?, name?, resume? })` | `workspace:spawn`; with `prompt` also `workspace:prompt` (the user confirms); with `resume` also `workspace:sessions` |
| `renameTile(id, name)` | `workspace:edit` |
| `openFolder(frameId)` | `workspace:edit` |

`spawnTile`'s free-form options are deliberately not exposed: an agent's command line
is not something a view chooses. `spawnAgent` takes a catalog id, never a command.

## Manifest

```json
{
  "id": "my-view",          // lowercase, digits, single dashes; "@your-login/my-view" to publish on HiveHub
  "name": "My view",        // ≤ 64 chars
  "version": "0.1.0",       // x.y.z (shown in `hive views list`; the host does not compare it)
  "entry": "index.html",    // one relative .html or .js inside the package
  "protocol": 1,            // a host refuses a protocol newer than its own
  "permissions": [],        // unknown names refused at install AND at load
  "assets": "dist",         // optional: dir served alongside the entry
  "wallpaper": false,       // optional: refuse the user's wallpaper (default: you get it)
  "author": "Ada",          // optional provenance, shown where the user decides to trust you
  "homepage": "https://…",  // https only — the host opens it in the user's browser
  "license": "MIT"          // a short identifier, not a sentence
}
```

Provenance is what the PACKAGE says about itself; nobody has checked it. The app labels it
"Says it is by" for that reason, and a registry's verified owner is a separate thing. Leave
the fields out rather than putting something untrue in them.

The wallpaper sits BEHIND your view, which only works while the view's FRAME stays
see-through. Never put `color-scheme` on `html` or `body`: the browser then paints the
frame's base canvas opaque and the wallpaper disappears, whatever your `background` says.
`applyThemeVars()` keeps the root at `color-scheme: normal` and gives you
`--hm-color-scheme` to put on the panels that scroll instead. Your own surfaces should be
translucent —
`color-mix(in srgb, var(--hm-color-bg2) calc(100% - var(--hm-glass, 0) * 30%), transparent)`
is what the shipped examples use. Set `"wallpaper": false` only if you paint an opaque
scene of your own: nothing would show through, and its animation still costs every frame.

`validateViewManifest()` from the SDK reports **every** problem, not the first — run it
in your own build and you will never be surprised by `hive views install`.

## Limits

| | |
| --- | --- |
| `MAX_SURFACE_RECTS` | 16 |
| `LAYOUT_MAX_BYTES` | 64 KB |
| id length | 256 chars |
| handshake timeout | 10 s (`connect({ timeoutMs })`) |
| activity | ≤ 4 messages/s, 256 watched tiles |
| event replay | 100 events, 1 hour |
| custom event | name ≤ 64 (`a-z0-9-` dotted, not `hive.`/`hm.`), payload ≤ 4 KB JSON, depth ≤ 8, 10/s |
| history | one request at a time, 30 days kept, 20,000 intervals |
| share | PNG ≤ 8 MB, ≤ 4096 px a side, one at a time, refused after 3 cancels in a session |

## Serving and the sandbox

Files are served over `hm-view://<id>/<path>` — a scheme of its own, so every plugin
has a distinct origin, the renderer CSP can allow exactly `frame-src hm-view:`, reads
are confined to the package dirs from the last scan, and every response carries:

```
default-src 'none';
script-src hm-view: 'nonce-…' 'wasm-unsafe-eval';
style-src hm-view: 'unsafe-inline';
img-src hm-view: data: blob:;
font-src hm-view: data:;
media-src hm-view: data: blob:;
worker-src blob:;
connect-src 'none'; frame-src 'none'; object-src 'none';
form-action 'none'; base-uri 'none';
```

Containment is checked on the **resolved** path with symlinks followed: a link inside a
downloaded package pointing outside it is a 403, not a read.
