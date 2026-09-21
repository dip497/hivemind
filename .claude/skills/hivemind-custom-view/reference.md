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
| `spawnAgent(agentId \| null, frameId \| null, { prompt?, name? })` | `workspace:spawn` |
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
