# Definition of done for a view

Paste this into the PR description with the boxes actually ticked. Every line is a
thing that has been wrong in a view someone shipped.

## It is for someone

- [ ] The PR names the person and the one job this view makes easier
- [ ] Every element on screen serves that job; decoration that does not is gone

## It renders

- [ ] `await connect()` before anything touches `hm.*`
- [ ] Draws frames, tiles and their membership from `structure`
- [ ] `names` updates titles without a structural redraw
- [ ] An empty workspace (no frames, no tiles) renders something, not a blank canvas
- [ ] A workspace with ~40 tiles is still legible and still interactive

## It draws only when it should

- [ ] No bare `requestAnimationFrame` loop anywhere
- [ ] Uses `createInvalidator`, or reimplements *all* of it: coalesce, skip while
      hidden, one catch-up frame on return, `reportFrame()`
- [ ] Verified: the workspace sits idle and CPU is flat
- [ ] Verified: switching away with ⌘E stops drawing, and coming back is correct, not stale

## Theme and status

- [ ] `applyThemeVars(hm)` called; no colour literals in the drawing code
- [ ] Readable in dark **and** light — checked both, not reasoned about
- [ ] idle / working / blocked / exited use the host's status colours and nothing else does
- [ ] Follows `--hm-radius` and `--hm-font-*` rather than its own

## Tiles and surfaces

- [ ] One status subscription per tile, unsubscribed when the tile disappears
- [ ] Surface rects are correct after `resize`
- [ ] `undock` drops the rect
- [ ] Nothing is painted under a surface rect
- [ ] `chrome` is `"bar"`, or `"none"` with your own undock affordance that works

## Host chrome and arrival

- [ ] Nothing of yours, and no surface bar, sits under the settings button in the top-right corner
- [ ] Arriving with a canvas selection marks it; it does not dock it
- [ ] The view has a focusable element and its keys work after clicking into it
- [ ] Checked with `scripts/view-check.mjs` against working, permission and idle agents

## Protocol manners

- [ ] `onReveal` answers with a real rect, or `null` when not showing that tile
- [ ] `selection` with `fresh: false` does not animate or steal focus on mount
- [ ] `setLayout` holds only view-owned state, under 64 KB
- [ ] State restored from `hm.hello.layout` on mount, and a **missing or corrupt**
      blob still mounts

## Manifest and packaging

- [ ] `validateViewManifest()` passes in your own build
- [ ] `permissions` is `[]`, or every entry is used by a feature you can point at
- [ ] Everything bundled; no bare imports, no CDN, no network at runtime
- [ ] `hive views install ./dist` from a clean checkout, then ⌘E, and it is there
- [ ] Installed from the built directory — not the source directory

## The sandbox

- [ ] No `fetch`, no WebSocket, no `localStorage`, no `node:*`
- [ ] Fonts and images are bundled or `data:` / `blob:`
- [ ] Opened the view's console: no CSP violations

## Failure

- [ ] Throwing during draw does not wedge the app — you land back on the canvas with
      every session intact
- [ ] A tile that vanishes mid-interaction (closed elsewhere) does not throw
