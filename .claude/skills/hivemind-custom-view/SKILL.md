---
name: hivemind-custom-view
description: Build a custom Hivemind workspace view — a sandboxed plugin that redraws the whole canvas from the host's projection of frames, tiles and agent status. Covers the v1 protocol, the surface hole-punch for live terminals, the render-on-demand rule, theming, permissions, packaging and install. Use when writing a new view, debugging one that renders nothing, or reviewing a view PR.
---

# Building a Hivemind view

## Why this exists

A view is not a panel in the app. It **is** the app's window onto running work: when a
view is active it draws every frame, every tile and every agent's status, and the user
is looking at your canvas instead of Hivemind's. A view that stops drawing does not
degrade — the user loses sight of agents that are still running.

The trap is not the protocol, which is small. It is that a view runs under
`default-src 'none'` in an opaque origin, and **the web reflexes that fail there fail
silently**. `fetch()` does not throw a useful error, it is refused by
`connect-src 'none'`. A Google Font link loads nothing. An `<iframe>` is `frame-src
'none'`. A CDN `<script>` is not on `hm-view:`. Authors lose an afternoon to a blank
canvas because they assumed a normal page.

Read [reference.md](reference.md) for the full message vocabulary and
[checklist.md](checklist.md) for what "done" means.

## What you are given, and what you may do

The host sends a **projection**, not the workspace. You get frames (id, title, colour),
tiles (id, frameId, kind, name), selection, per-tile status on subscription, theme,
viewport and visibility. You never get a command line, a working directory, file
contents, or anything a terminal is showing.

You may send back: selection and focus changes, surface rects, a reveal answer, a
persisted layout blob, a frame count, and — only if the manifest asked — spawn and
close commands.

That asymmetry is the design. A view decides *how the workspace looks*; it does not
decide what runs.

## The smallest view that works

Four files. `hivemind-view.json`, an entry, your code, a build that copies all three
into one directory.

```json
{
  "id": "my-view",
  "name": "My view",
  "version": "0.1.0",
  "entry": "index.html",
  "protocol": 1,
  "permissions": []
}
```

```ts
import { applyThemeVars, connect, createInvalidator } from "@hivemind/view-sdk";

const hm = await connect();          // resolves after the host's hello
applyThemeVars(hm);                  // --hm-color-*, --hm-accent, --hm-font-*, …

let frames = [], tiles = [];
const { invalidate } = createInvalidator(hm, draw);

hm.on("structure", (s) => { frames = s.frames; tiles = s.tiles; invalidate(); });
hm.on("names", ({ names }) => { /* titles changed, nothing structural */ invalidate(); });
hm.on("resize", () => invalidate());

function draw() { /* paint frames and tiles into your canvas or DOM */ }
```

`connect()` rejects after 10 s if no handshake arrives. Await it before touching
anything else — `hm.hello` is not populated until it resolves.

## The rule that matters most: draw on demand

**Never run a `requestAnimationFrame` loop.** The host checks whether a view is
drawing, and a view that paints 60 times a second while nothing changes burns the
user's battery behind a workspace they are not even looking at.

`createInvalidator(client, draw)` is the whole discipline: it coalesces to one frame,
**skips drawing entirely while hidden**, remembers that it was dirty, and draws one
catch-up frame when the view becomes visible again. It also calls `reportFrame()` for
you, which is what the host reads.

Call `invalidate()` on a real change. That is it.

If you genuinely animate (an easing, a spring settling), drive it from `invalidate()`
while the animation is live and stop calling it when the animation ends. An animation
that never ends is a rAF loop wearing a costume.

## Surfaces: the hole punch

A live terminal is a real xterm the host owns. A view cannot render one. What you do
is **declare where one belongs** and the host positions it above your iframe:

```ts
hm.setSurfaceRects([{ tileId, x: 320, y: 0, w: hm.viewport.w - 320, h: hm.viewport.h }]);
```

Coordinates are pixels in your viewport. At most 16 rects. Identical rects are not
re-sent, so calling it on every draw is cheap and correct.

Three things authors get wrong:

- **The rect is a hole, not a layer.** Anything you paint under it is invisible.
  Do not draw your own chrome there.
- **`chrome: "none"`** means you own undocking. The default `"bar"` gives the host's
  slot bar (name, status, pop-out, undock) and is what you want unless you have built
  that affordance yourself.
- **Listen for `undock`.** The user can undock from the host's bar or with Shift+Esc.
  The tile is already released when the message arrives; drop the rect from your model
  or your UI will claim a surface that is gone.

## Theme: never hardcode a colour

`applyThemeVars(hm)` writes the host theme onto your document as custom properties and
keeps them current when the user changes appearance:

```
--hm-color-<token>   every colors entry (bg, bg2, fg, brand, ok, …)
--hm-accent   --hm-radius   --hm-font-ui   --hm-font-mono
--hm-surface  --hm-terminal-bg  --hm-glass (0|1)  --hm-mode
```

Write `background: var(--hm-color-bg2)` and your view follows the user's theme for
free. A hardcoded `#1a1a1a` is a view that is unreadable the moment someone switches to
light mode.

**The four status colours are meaning, not decoration.** idle, working, blocked and
exited read as those states everywhere else in the product. Do not spend them on
anything else — a view that colours decorative particles amber teaches the user to
ignore "working".

## Status is a subscription

Status does not arrive with `structure`. Subscribe per tile, and keep the
unsubscribers:

```ts
const off = new Map<string, () => void>();
hm.on("structure", ({ tiles }) => {
  for (const t of tiles) {
    if (!off.has(t.id)) off.set(t.id, hm.subscribeStatus(t.id, (s) => { status.set(t.id, s); invalidate(); }));
  }
  for (const [id, stop] of off) if (!tiles.some((t) => t.id === id)) { stop(); off.delete(id); }
});
```

Leaking subscriptions for closed tiles is the most common resource bug in a view.

## Permissions: ask for nothing

The base set — projection, status, selection, reveal, surfaces, layout — needs no
permission. Only two exist:

| Permission | Unlocks |
| --- | --- |
| `workspace:spawn` | `spawnTile`, `spawnVis`, `spawnClaude`, `addFrame` |
| `workspace:close` | `closeTile` |

Requesting one is a line in the install review a user has to accept, and an unknown
name is refused at install **and** at load. Calling a command your manifest did not
request throws locally, so a missing permission shows up as a broken button, not a
silent no-op. Ship with `"permissions": []` unless a feature genuinely needs more.

## Persisting your own state

`hm.setLayout(data)` stores an opaque blob (≤ 64 KB) under your plugin id, debounced.
It comes back as `hm.hello.layout` on the next mount. Use it for view-owned state — a
zoom level, a spread, which panel is open. Do not put workspace state there; the
workspace already has some.

## Answer `reveal`

The host asks "where is this tile?" when something elsewhere wants to point at it.
Answer with a rect in your coordinates, or `null` if you are not showing it:

```ts
hm.onReveal((tileId) => rectFor(tileId) ?? null);
```

Ignoring it is not fatal, but "reveal in view" silently does nothing, which reads as a
broken app rather than an unimplemented view.

## Build and install

One directory with the entry, the manifest, and everything bundled. No bare imports at
runtime — the SDK is a build-time dependency:

```js
await build({ entryPoints: ["src/main.ts"], bundle: true, format: "esm",
              target: "es2022", outfile: "dist/my-view.js" });
cpSync("src/index.html", "dist/index.html");
cpSync("hivemind-view.json", "dist/hivemind-view.json");
```

```bash
node build.mjs
hive views install ./dist      # then ⌘E in the app until your view
```

An `entry` ending in `.js` is wrapped in a host-generated page for you — use that when
you have no HTML of your own. Everything referenced must be a relative path inside the
package; a symlink pointing out of it is refused, not followed.

## What the sandbox refuses

Your CSP is `default-src 'none'` with scripts and styles only from `hm-view:`.
Concretely:

| You wrote | What happens |
| --- | --- |
| `fetch()` / `XMLHttpRequest` / WebSocket | refused — `connect-src 'none'`. There is no network, by design |
| `<link>` to Google Fonts, a CDN script | loads nothing, no error worth reading |
| `<iframe>` | `frame-src 'none'` |
| `require`, `process`, `node:*` | there is no node here |
| `localStorage` | opaque origin — use `setLayout` |

Images, fonts and media may be `data:`, `blob:` or bundled files. Workers may be
`blob:`. WebAssembly is allowed (`wasm-unsafe-eval`). Bundle what you need.

## Start from a person, not a visual

A view that looks impressive and helps nobody is the easiest kind to build and the most common
kind to delete. Before any pixels, write down who it is for and the one job it makes easier —
"never leave an agent waiting", "type into every terminal of this task at once" — and cut
anything that does not serve that job. `docs/design/views-by-persona-2026-09-16.md` is the worked
example; `examples/views/{queue,tiled,board}` are the results.

## True, and not guessable

Each of these cost a view real time to find out.

- **Only the active view is mounted.** Switching to Canvas unmounts yours. You cannot record
  history while you are not on screen — persist timestamps in `setLayout`, and show a
  remembered one only as "since", only if the tile is still in that state.
- **The app's settings button floats over the top-right ~56px of every view.** Keep your own
  controls, and the host bar of any surface rect, out of that corner.
- **The status colours are the app's**: working = `brand`, needs you = `warn`, idle = `fg3`,
  exited = `err`. Remap them and the user misreads the rest of the app. Frame colours identify a
  frame; mute them so they never compete with a status.
- **Every agent tile has kind `claude`**, whatever the provider. A `planReview` tile is a human
  decision waiting, which usually belongs with "needs you".
- **On arrival, `selection` carries whatever was last selected on the canvas** (`fresh: false`).
  Mark it; do not dock it — the user came to your view, not to that tile.
- **Keys reach your view only while its document has focus**, and a docked terminal takes them.
  Give the view a focusable element (`tabindex="0"`) and say which keys it answers.
- **`chrome: "bar"` puts the host bar above the tile's own header** — two headers. Use
  `"none"` when your view already shows the tile's name and a way to close it.

## Check it against real states

```bash
cd apps/desktop
xvfb-run -a -s "-screen 0 3400x2200x24" node scripts/view-check.mjs <view|all> <out-dir> [palette]
```

It runs the built app on a private profile, spawns agents through a `claude` shim whose screens
are the ones the real detector reads — working, asking permission, idle — and screenshots your
view in each state. Two things it learned the hard way: the app types an agent's first prompt
once its screen reads idle (it is not an argument), and a "working" screen that stops moving
reads as finished, correctly, because a real one never stops.

## Before you finish

| Mistake | Fix |
| --- | --- |
| Blank canvas, no error | You drew before `await connect()`, or you assumed network |
| Fan spins on an idle workspace | A rAF loop. Use `createInvalidator` |
| Unreadable in light mode | Hardcoded colours. Use `--hm-color-*` |
| Terminal appears in the wrong place | Rects are viewport pixels, and stale after `resize` |
| A closed tile still has a surface | You ignored `undock`, or leaked its status subscription |
| "Reveal in view" does nothing | No `onReveal` handler |
| Button silently dead | Command needs a permission the manifest did not request |

Work [checklist.md](checklist.md) before calling a view done; it is the definition of
done for a view PR and belongs in the description.
