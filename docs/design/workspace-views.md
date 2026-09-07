# Workspace Views — plugin architecture

**Status:** all milestones done — 1: core/view split, TileHost, canvas + windows
as built-in plugins, versioned per-view layouts, crash fallback (2026-09-05);
phase 3: the built-in World view (2026-09-07); phase 4: isolated community
views + `@hivemind/view-sdk` (2026-09-07). Open follow-ups are listed in each
phase's section (docked-typing lag in a community view on software GL, the
World's switch-after-undock, publishing the SDK to npm).
**Date:** 2026-09-05, updated 2026-09-07.

The same workspace — frames bound to repos, live agent tiles, their sessions —
can be looked at through different *views*: today an infinite canvas and a
VS Code-style tab strip; later a Three.js building, a Mars base or a solar system
where each frame is a structure and each running agent is something alive in
it. A view is a **plugin**: it arranges and navigates; it never owns a session.

```
apps/desktop/src/renderer/src/
  Workspace.tsx                 runtime + composition root (was Canvas.tsx)
  workspace/
    workspace-view.ts           the contract (model, commands, plugin) + registry
    tile-surfaces.ts            pure: every open tile's body + repo scope
    tile-host.tsx               TileHost (owns bodies) + TileSlot (views borrow them)
    view-layout-store.ts        versioned per-view, per-repo layout blobs
    view-host.tsx               crash boundary + fallback panel
    views/
      index.ts                  registers the built-ins
      CanvasView.tsx            xyflow presentation (plugin "canvas")
      canvas-layout.ts          its layout blob: positions / sizes / viewport
      canvas-runtime.ts         milestone-1 seam (see "Debt")
      WindowsView.tsx           tab strip presentation (plugin "windows")
      windows-layout.ts         its layout blob: minimized tabs / active tab
```

## Who owns what

| Concern | Owner |
|---|---|
| Frames, repo bindings (worktree / workspace folder / `ssh://`), tile identity + open set, tile→frame membership, selection, names, editor tabs, HCP wiring, agent awareness, commands, core persistence | **Runtime** (`Workspace.tsx` + the existing `use*` hooks) |
| Tile **bodies** — terminal / editor / diff / browser / issues / plan review, and the PTY, CodeMirror or `<webview>` inside | **TileHost** (`tile-host.tsx`) |
| Arrangement + navigation (where a tile is, what's focused, camera), its own persisted layout | **View plugin** |

### The contract (`workspace-view.ts`)

A plugin is `{ id, label, hint, icon, component }`. Its component receives:

- `model: WorkspaceViewModel` — read-only: `tiles`, `frames`, `frameOf`,
  `tileNames`, `agentTitles`, `selectedTileId`, `selectedFrameId`, the
  display-ready `layerTiles` / `layerFrames`, `frameActions` (spawn-into,
  worktree, workspace, git …), `links` (live agent pipes + spawn parentage),
  `repoPath` / `root` / `cwd`, and `layoutKey` (the per-repo persistence key).
- `commands: WorkspaceCommands` — `selectTile`, `selectFrame`, `focusTile`,
  `closeTile`, `spawnTile`, `spawnVis`, `spawnClaude`, `addFrame`.

No react-flow nodes cross the boundary. Where a tile body should appear, the
view renders `<TileSlot tileId=…/>`. That is the whole rendering contract for
bodies — a 3D view can put a slot on a `CSS3DObject`, a tab strip puts one per
tab, the canvas puts one in each xyflow node.

Per-view state goes through `useViewLayout(spec, model.layoutKey)` where
`spec = { viewId, version, initial, migrate }`. The blob is stored under
`hivemind:view-layout:<viewId>:<repo>` as `{ v, data }`; a version mismatch
hands the old payload (or `null` for "no blob") to `migrate`. Adding, removing
or reshaping a view never touches the core blob or another view's. Every blob
(core, canvas geometry, per-view) is written through one `useDebouncedSave`:
trailing-debounced, flushed under the OLD key on a repo switch, on unmount and
on `beforeunload`. A pan/drop rewrites only the canvas geometry blob; the core
blob rewrites on structural edits.

Live agent **status** is not in the model on purpose: `agent-status-bus.ts`
already fans it out at ~1 Hz per tile and the Layers rail subscribes per row.
A view that wants to glow a building red on `blocked` subscribes the same way.

### Lifetime ownership — why nothing remounts

The bug this milestone had to fix: bodies used to be children of the active
view, so switching views unmounted every one. `TerminalTile`'s effect cleanup
runs `ptyDetach`, and main routes that to `killRemotePty` for an `ssh://` tile
(remote PTYs run in-main; there is no daemon to reattach to) — **a view switch
killed remote agents**. Local terminals "only" tore down xterm + WebGL and
replayed; editors lost unsaved buffers; browsers reloaded.

Now `TileHost` renders every surface exactly once, via `createPortal` into a
per-tile `<div>` it creates lazily and keeps for the life of the tile
(`surfaceEl(id)`). The portal container never changes, so React never remounts
the body; the only unmount is the tile closing. `TileSlot` **adopts** the
element by moving it into place (`appendChild`) — the same DOM-reparenting
trick `tile-fullscreen.tsx` already used to fullscreen a live xterm — and parks
it again on unmount. Details that matter:

- **Mount after adoption.** A body is not mounted until a slot has adopted its
  element once (`useAdopted`, a tiny external store). xyflow renders its
  NodeWrapper one commit after the tile exists, so without the gate a terminal
  opened + spawned at park size and resized a frame later, and a `<webview>`
  created its guest twice (park insert, then slot insert) and leaked one.
- **Deferred park.** A slot's cleanup parks in a microtask, so a view switch
  (old slot cleanup + new slot adoption in one commit) moves the element slot
  to slot with no park hop — one `<webview>` guest re-attach per switch, not two.
- **Frozen park.** Un-adopted surfaces (a minimized tab, a view that doesn't
  show the tile) sit in `#hm-tile-park` hidden and frozen at their last slot
  size — never `display:none` / 0×0 (xterm's fit computes garbage) and never
  full-window (every parked terminal reflowed + re-sized its PTY, on park, on
  restore and on each window resize). The host dispatches
  `hivemind:surface-adopted` / `-parked` on the element; `TerminalTile` skips
  its ResizeObserver while parked, defers a fit while its host is hidden, and
  ranks a parked or hidden tile 0 for the WebGL slot manager (see "Switch-path
  attribution" below for why resizing a live WebGL terminal must be avoided).
- **Selection is decided on the shared layer.** React synthetic events from a
  portaled body never reach a view's own handlers (xyflow's `onNodeClick`), so
  the surface element's native `pointerdown` (primary button) calls the runtime's
  `selectTile`. The canvas adds its own native `click` listener for the
  canvas-only extras (seen-tracking, crisp snap, exact 1:1 focus on a new
  selection, context-menu suppression).

Consequences worth knowing:

- Views may mount/unmount their chrome freely. The canvas still keeps
  `onlyRenderVisibleElements={false}`, but now to avoid a refit flash rather
  than to protect a session.
- The TileHost sits **outside** the view's crash boundary: a view that throws
  loses its arrangement, not the terminals.
- `<webview>` limit: Chromium re-attaches the guest when its element is
  reparented, so a browser tile's *page* reloads once per view switch. React
  state (tabs, address, history) survives; page scroll/form state does not. The
  fix is hosting browser guests as main-process `WebContentsView`s positioned
  over the slot — a follow-up, not a milestone-1 blocker (it was a full remount
  before).
- `selected` is a runtime fact (one selected tile across views), fed to the body
  by the host. The Windows view's active tab is a *projection* of it: whatever
  selects a tile (tab click, spawn, "open in editor", HCP `tile.focus`, a toast,
  the rail) becomes the visible tab, un-minimizing it if needed; the stored
  `activeTabId` is only the fallback when nothing is selected.
- The canvas reads react-flow's `defaultViewport` from the live viewport ref
  (kept exact via `useOnViewportChange`), and ignores camera requests that
  predate its mount — a remount resumes where the camera was.
- The active view id is one external store (`view-mode-store.ts`,
  `useSyncExternalStore`) shared by the runtime and Settings ▸ View.

### Fallback

`resolveViewId` maps the stored preference to a registered plugin, else
`FALLBACK_VIEW_ID` ("canvas"), else the first registered view. A plugin that
throws is caught by `ViewErrorBoundary` (`view-host.tsx`): a non-fallback view
switches to the fallback with a toast; the fallback itself failing shows the
failure panel with Retry + the other views. Sessions are untouched either way.

### Persistence + migration

- Core blob (`hivemind:canvas-layout:<repo>`, `canvas-persistence.ts`) is now
  `version: 2`: frames, tiles, tileNames, editorTabs, frameOf. Tile
  positions/sizes/viewport are no longer *read* from it by v2+, but the writer
  still mirrors them in for one release so a pre-v2 build on the same profile
  (downgrade, or a dev profile shared with an older checkout) keeps its layout.
- Canvas layout (`hivemind:view-layout:canvas:<repo>`): on first load with no
  blob it imports positions/sizes/viewport from the pre-v2 core blob. A core
  blob found at a pre-v2 version *with* geometry means an older build saved more
  recently (a v1.16.0 ↔ dev round trip on one profile) and is re-imported as the
  newer arrangement (`loadCanvasLayout`); a v2 build re-stamps the core blob on
  its first save, so that override lasts one launch.
- Windows layout (`hivemind:view-layout:windows:<repo>`): imports the legacy
  `hivemind:windows-minimized:<repo>` array once.
- View preference (`hivemind:view-mode`) is a raw id string; unknown → fallback.

## Performance (acceptance constraint)

Zero *perceptible* lag under several streaming agents is a primary constraint.
What the architecture guarantees and what a plugin must uphold:

- **Terminal output never reaches React.** xterm writes are imperative inside
  `TerminalTile`; status goes over `agent-status-bus` (imperative, per-tile
  subscribers). The workspace re-renders only on structural edits (spawn, close,
  rename, membership, selection) and on the ~600 ms agent-title tick — and that
  tick is excluded from the node-array, surface-list and canvas-node memos.
- **One live instance per tile.** The TileHost is the only renderer of bodies;
  views place `<TileSlot>`s. Duplicate instances = duplicate PTY attach + WebGL
  contexts; never do it.
- **Inactive views do no work.** Only the active plugin is mounted; a switch
  unmounts the previous one. A plugin must release every listener, timer and
  `requestAnimationFrame` loop in effect cleanups, and should also stop its
  render loop while `document.hidden`. Parked (un-adopted) surfaces still
  receive PTY output (the buffer must stay current) but paint nothing visible;
  the WebGL slot manager already caps GPU contexts.
- **Selective subscriptions.** A 3D view that wants to colour a building by
  agent state subscribes per tile on the status bus (like a Layers row does),
  not to `model` changes.
- **Bounded buffering / backpressure** stays where it is: the PTY daemon
  coalesces output and applies a write-queue watermark (pauses the child); the
  renderer never buffers unboundedly.
- **No serialization on the interaction path.** Layout blobs are trailing-
  debounced (250 ms) and flushed on unload/unmount; nothing JSON-stringifies on
  a drag frame or a keystroke.
- **Lazy heavy views.** `component` may be `React.lazy`; Three.js and its assets
  must not be in the default chunk.

Measured with `apps/desktop/scripts/perf-views.mjs` (headless Electron under xvfb, N shell tiles
each streaming ~100 lines/s, sampling rAF intervals, `longtask`s, a 16 ms
timer's drift as input-latency proxy, `app.getAppMetrics()` for CPU/RSS, and
view-switch time to the second painted frame). xvfb has no GPU, so absolute numbers are pessimistic and only before/after
deltas on the same machine are meaningful.

**Measured 2026-09-06** — same machine, xvfb 1600×1000 (software GL), 4 shell
tiles × ~50 lines/s, in-process PTYs, `scripts/perf-views.mjs`. `base` is
43ca4ff built in a separate worktree (1-min load 5 at start); `after` is this
branch after the review fixes (load 4.8 at start, ~10 by the end — the machine
was shared, so treat ±20 % as noise). Two earlier pairs taken at load ~72 were
discarded.

| metric | base 43ca4ff | after (branch) |
|---|---:|---:|
| canvas quiet · fps / frame p95 | 59.7 / 18 ms | 60 / 18 ms |
| canvas streaming · fps / frame p95 / longtasks | 9.6 / 134 ms / 0 | 11.2 / 105 ms / 0 |
| typing while streaming · lag p95 / longtasks | 15 ms / 0 | 12 ms / 0 |
| wheel pan · fps / frame p95 / frames >50 ms | 9.9 / 123 ms / 242 | 9.8 / 123 ms / 182 |
| tile drag · fps / frame p95 | 10.2 / 113 ms | 10.1 / 152 ms |
| windows view streaming · fps | 59.8 (*its streams were killed on switch*) | 12.4 (4 live streams) |
| switch → windows / → canvas (median of 4) | 301 / 266 ms | 614 / 567 ms |
| live xterm instances after 8 switches | 4 | 4 |
| streams survive the switch | no | yes |
| renderer RSS while streaming | 245 MB | 241 MB |

**Switch-path attribution (2026-09-06; per-switch CDP CPU profiles +
`performance.measure` per tile, runtime bisect flags over every switch-path
addition).** The review build spent 300–900 ms of main-thread long tasks per
switch. Bisecting each addition (mount-after-adopt gate, microtask/frozen
park, adopt/park handlers + parked priority, RO gate, derived Windows
selection, unmount viewport read) changed nothing — with all of them disabled
the long tasks stayed. Per-switch profiles put 326–584 ms of self-time in
`WebglRenderer.handleResize`, GC ≤ 31 ms, and the cost was identical with 3 s
or 30 s of scrollback: **resizing a live WebGL terminal** makes Chromium flush
the context's pending draws before it reallocates the canvas (100–600 ms per
tile on swiftshader, and the dominant cost with a GPU too). A fresh canvas has
no pending draws, which is why the baseline — which destroys and recreates
every terminal on a switch — paid ~150 ms for four *creations*. Two secondary
costs were real but small: the refit in `onAdopted` doubled the fits
(ResizeObserver notifications land after rAF, so they never coalesced), and
the switch stall could cross the 1.5 s crisp-when-idle threshold and trigger
DOM→WebGL re-acquires (`getContext`, 0.4–2.4 s per tile here). A third one
appeared on the first switch only: a tile that had been off-screen in the
canvas "intersected" the viewport behind an inactive tab and lazily acquired a
WebGL context (760 ms).

Fix (`TerminalTile`): a tile whose host is not shown — `visibility:hidden`
under an inactive Windows tab, or parked — **defers its fit** until it is
shown (re-checked two frames later, because xyflow mounts a node
`visibility:hidden` until measured; otherwise applied by the selection effect
when the tab is activated) and **ranks 0 for the WebGL slot manager** (never
acquires a context while hidden). The only terminal that resizes on a switch
is the shown one, which is the selected one, on the cheap DOM renderer
(1–38 ms). On the way back the deferred tiles are at their old size, so their
fit is a no-op. Adoption counts as stream activity so the quiet timer cannot
fire off a switch stall; the ResizeObserver is the single fit path; slot sizes
come from an observer, not `offsetWidth`.

Per switch after the fix (4 streaming tiles, xvfb, load 7–11, this machine):

| # | to | painted | long tasks | base 43ca4ff (same harness) |
|---|---|---:|---:|---:|
| 1 | windows | 220 ms | 0 | 301 ms / 184 ms |
| 2 | canvas | 182 ms | 90 ms | 224 / 176 |
| 3 | windows | 219 ms | 0 | 381 / 140 |
| 4 | canvas | 165 ms | 56 ms | 379 / 205 |
| 5 | windows | 223 ms | 0 | 147 / 115 |
| 6 | canvas | 174 ms | 55 ms | 266 / 164 |
| 7 | windows | 198 ms | 0 | 254 / 173 |
| 8 | canvas | 227 ms | 55 ms | 140 / 72 |

Medians 220 ms → windows (0 ms long tasks on every switch) and 182 ms →
canvas (55–90 ms: the canvas view's own mount commit — react-flow, four
nodes, the rail), against the baseline's 301 / 266 ms with 72–205 ms long
tasks; sessions intact (4 live xterms throughout). Canvas scenes unchanged:
quiet 59.4 fps, streaming 9.7 vs 9.6, pan 9.7 vs 9.9, drag 9.3 vs 10.2, zero
long tasks in every canvas scene on both sides.

Reading: canvas scenes (quiet, streaming, typing, pan, drag) are equal within
noise — zero long tasks, input-loop lag ≤ 15 ms in both — and the remaining
frame cost is software rasterisation of four DOM-rendered terminals, not React
or react-flow. A switch costs ~0.3 s more than the baseline with four live
tiles because the baseline destroyed every terminal (empty buffers, in-process
PTYs killed) while the branch re-wraps each terminal's scrollback to the new
column count; that cost scales with buffer size and is the price of keeping
sessions. The baseline's 60 fps Windows view is idle for the same reason.
Not measured: GPU display, remote (`ssh://`) tiles, >6 tiles.

## Debt (milestone-1 seam)

`workspace/views/canvas-runtime.ts` is a React context only `CanvasView` may
read. Tile positions/sizes/viewport and the drag/resize/focus handlers still
live in `Workspace.tsx` because the hooks that mutate them — `useSpawn`'s
in-frame placement, `useFrameOps`' auto-fit/arrange, `useWorktrees`' frame
creation, `useNodeDragStop` — also do core work and must run while another view
is active (a tile spawned from Windows mode needs a canvas slot for when you
switch back). Likewise `FrameState` still carries `x/y/w/h` on the core record.

## Follow-up phases

### Phase 2 — headless layout engines + frame geometry split (not started)

- Give a plugin an optional `layout` hook the runtime runs for *every*
  registered plugin regardless of the active view (a headless "layout engine").
  Move `placeInFrame`, auto-fit, arrange and drag-stop into the canvas engine;
  the runtime's `spawnTile` becomes pure core (create tile + membership) and the
  engines react. Delete `canvas-runtime.ts`.
- Split `FrameGeometry` out of `FrameState` into the canvas layout blob (bump
  `CANVAS_LAYOUT.version` to 2 with a migrate).
- Commands grow only as views need them (`renameTile`, `openFile`, …).

### Phase 3 — the World view (built-in, privileged) — as built

Shipped as the third built-in plugin, `"world"` (`workspace/views/world/`):

- **Scene** (`world-scene.ts`, plain three.js, no React): one island per frame
  (a plate + a building tinted with the frame colour) auto-placed on a square
  spiral (`world-layout.ts`, `placeIslands`), one block per tile on the island's
  grid (`placeTiles`). Block colour = agent status through
  `commands.subscribeTileStatus` — one subscription per block, one repaint per
  transition, never a scene rebuild. Hover shows the tile name (a DOM label);
  orbit / pan / zoom via `OrbitControls` with damping OFF.
- **Docking**: click a block → `commands.selectTile` + a `<TileSlot>` in a DOM
  pane *beside* the WebGL canvas (`data-world-dock`, 56 % width, sibling not
  overlay — see the numbers below for why). One slot at most; every other
  tile stays parked. Esc undocks unless the docked terminal has the keyboard
  (Esc is a TUI interrupt) — then × / a header click first. Click an island →
  the camera flies to it in one step (no tween loop). A selection that changes
  while the world is up (rail, an agent's `tile.focus`) docks that tile; the
  selection you arrive with is left alone (entering shows the map).
- **Render on demand**: `invalidate()` schedules at most one frame; only camera
  change, status change, hover change, dock/undock and resize invalidate.
  Nothing renders while `document.hidden` (one catch-up frame on return). The
  e2e suite reads the scene's frame counter to prove no frames are drawn while
  nothing changes.
- **Retained across switches**: the component unmounts on every switch like
  any view, but the `WorldScene` (renderer, GL context, compiled programs,
  geometry) is module state keyed by `layoutKey`: unmount `detach()`es it —
  canvas out of the DOM, every listener and the ResizeObserver off, nothing
  can schedule a frame — and the next mount `attach()`es the same scene and
  draws one frame. `dispose()` (real teardown) runs on workspace change and
  `beforeunload`. A context + shader compile per mount was 0.5–1.5 s of long
  tasks per switch to the world (measured); retained it is 0.
- **Lazy**: `component: lazy(() => import("./WorldView"))`; three.js is forced
  into `vendor-three-*.js` by `manualChunks`, the view into `WorldView-*.js`.
  `renderer-chunks.test.ts` pins the entry chunk size (baseline + 4%) and asserts
  the three chunk exists and is not statically imported.
- **Layout blob**: `useViewLayout` `"world"` v1 — camera pose + island spots.

**Measured 2026-09-07** — `scripts/perf-views.mjs` world scene set, same
harness and machine as above (xvfb 1600×1000, software GL, 4 shell tiles
× ~50 lines/s, in-process PTYs). Interleaved runs: `base` is the branch tip
before the world view (bfe9ad6, built in a worktree, `PERF_SKIP_WORLD=1`),
`world` is this branch; 4 valid runs each, alternated base/world, 1-min load
10–24 throughout (shared machine; ±20 % is noise). Two earlier world runs with
the dock as a DOM overlay and a per-mount scene are excluded; their failures
are what the two rules above fix.

Canvas / windows scenes, median of 4 runs per side (unchanged within noise):

| metric | base bfe9ad6 | world build |
|---|---:|---:|
| canvas quiet · lag p95 | 0.2 ms | 0.3 ms |
| canvas streaming · fps / lag p95 / longtasks | 9.4 / 3.8 ms / 0 | 12.2 / 3.9 ms / 0 |
| typing while streaming · lag p95 | 11.9 ms | 13.3 ms |
| wheel pan · fps / lag p95 | 8.1 / 12.1 ms | 10.8 / 11.3 ms |
| tile drag · fps / lag p95 | 8.0 / 15.6 ms | 10.2 / 12.4 ms |
| windows streaming · fps / lag p95 | 10.3 / 17.0 ms | 14.6 / 12.8 ms |
| switch → windows / → canvas (median) | 354 / 234 ms | 250 / 211 ms |
| canvas quiet CPU (all processes) | 10.5 % | 9.2 % |
| streaming CPU / windows CPU | 50.7 / 51.1 % | 55.4 / 53.1 % |

World scenes (the two final runs; the acceptance comparisons are within-run so
shared load cancels):

| metric | run A | run B | acceptance |
|---|---:|---:|---|
| world quiet · fps / lag p95 / longtasks / **frames drawn** | 58.4 / 0.3 ms / 0 / **0** | 55 / 0.4 ms / 0 / **0** | render on demand |
| world idle CPU vs canvas idle CPU | 8.6 vs 9.0 % (−0.4) | 11.4 vs 9.1 % (+2.3) | within 2 % — B is at the edge, the median over the 4 world runs is +0.3 |
| world streaming, undocked · lag p95 / frames drawn | 9.0 ms / 0 | 9.4 ms / 0 | parked tiles paint nothing |
| world streaming, docked · lag p95 / frames drawn | 12.5 ms / 0 | 10.5 ms / 0 | terminal repaints do not touch the scene |
| **typing into the docked tile · lag p95** vs canvas typing | **8.8 vs 12.6 ms** (−3.8) | **10.4 vs 10.1 ms** (+0.3) | within 5 ms ✓ |
| orbit (60 pointer moves) · frames drawn / frame p95 / longtasks | 60 / 160 ms / 0 | 60 / 121 ms / 0 | one frame per move, no loop |
| canvas ↔ world switch, median / long-task max over 7 (plain) | 183 → world, 156 → canvas / 173 ms | 246 → world, 195 → canvas / 0 ms | ~0 both directions ✓ (the 173 ms was the first → world of run A; every other switch 0) |
| world → canvas right after an undock | 386 ms / 318 ms long task | 350 ms / 281 ms | see below |
| dock/undock cycle ×8 · lag p95 / long-task max | 123 ms / 286 ms | 173 ms / 370 ms | — |
| live xterm instances after all switches | 4 | 4 | sessions intact |
| streaming CPU docked in world vs canvas streaming | 53 vs 58.5 % | 56 vs 56.3 % | — |

For comparison the canvas ↔ windows switches in the same runs carried 0 ms →
windows and 51–76 ms → canvas long tasks (the canvas view's own mount commit).

Two trade-offs the numbers forced:

- **The dock is a sibling pane, not an overlay.** With the terminal panel
  positioned over a full-window WebGL canvas, every terminal repaint made the
  compositor blend the two layers: docked typing lag was 5.9 ms *over* the
  canvas typing lag (limit 5 ms). Side by side the layers do not overlap and
  typing in the dock is at or below canvas typing. The price is that the scene
  narrows to 44 % while a tile is docked (one resize + one frame).
- **The docked tile is resized twice.** Docking adopts a surface that was last
  laid out at its canvas size; undocking parks it at the dock size. The next
  switch to the canvas therefore refits one live WebGL terminal to its canvas
  size — the 280–320 ms long task on the "right after an undock" row (the
  same `WebglRenderer.handleResize` flush documented above). A plain switch
  after a session that never docked, or docked and switched without
  undocking, pays nothing. Not fixed here: it is the geometry-of-a-parked-
  tile gap in the table below, and the honest fix is the host restoring the
  view's own slot size on adopt rather than the plugin's.

#### What the World view needed that the contract did not provide

This list is the input for the isolated community plugin API (phase 4): each row
is something a plugin outside the privileged renderer will need the host to
carry across the boundary, or to do on its behalf.

| need | how the World view got it | what phase 4 has to offer |
|---|---|---|
| **Live status per tile** | Not on the model (a ~1 Hz tick must not re-render bodies). Added `commands.subscribeTileStatus(tileId, cb)` + `tileStatus(id)` backed by the awareness bus. | A per-tile status stream over the `MessagePort` (subscribe/unsubscribe by id), replaying the last value. |
| **Frame colour as a number** | `FrameState.color` is a CSS string (`oklch(...)`) three.js cannot parse; resolved through a 2D-canvas fill (`cssColorToHex`). | Send colours pre-resolved (hex) in the projection, or document the CSS form. |
| **Display names** | `model.layerTiles[].name` (renames + agent titles resolved by the runtime) — read through a ref so title churn never triggers a reconcile. | The projection carries resolved names; name updates must be separable from structural updates. |
| **Membership + structure only** | The scene reconciles from `frames`, `tiles`, `frameOf` — `agentTitles` is deliberately not a dependency. | Structural updates (frames/tiles/membership) as their own message type. |
| **A live surface inside the scene** | A real `<TileSlot>` in a DOM overlay; the slot fills the panel through the host's adopted-surface CSS. | The hole-punch: the plugin declares a screen rect, the host positions the slot. `projectTile()` already yields the rect a plugin would send. |
| **Selection coming from elsewhere** | `model.selectedTileId` — with a view-side rule to ignore the selection you arrive with. | Selection is host state; the projection must say whether a selection is new since the plugin mounted. |
| **Fly-to / focus semantics** | `commands.focusTile` is defined by the canvas; the world does its own camera move and calls `selectFrame`. | Plugins own their camera; the host only asks "reveal this tile" and the plugin answers with a rect. |
| **View switching in tests / tools** | ⌘E order is registration order, so a third view changed every "toggle back" round trip; `hivemind:set-view-mode` became the explicit way to target a view (specs + perf harness). | The host exposes explicit `setView(id)`; cycle order is a host concern. |
| **Assets** | None: procedural geometry, no textures/fonts. | Plugins that ship assets need a manifest-declared asset path served into the iframe. |
| **Crash isolation** | The ViewHost boundary + a test seam that throws in render. | An iframe crash is a process/iframe reload, not a React boundary; the host must detect and fall back the same way. |
| **Perf visibility** | `frameCount` on the scene (test seam) to prove render-on-demand. | A plugin-side "frames drawn" counter the host can read for its own budget checks. |
| **Expensive state across mounts** | The view unmounts on every switch, but a GL context + shader compile per mount cost 0.5–1.5 s; the scene lives in module state and is attached/detached per mount, disposed on workspace change / unload. | A plugin lifecycle with `hide`/`show` distinct from `unmount`, so an iframe (its whole GL state) survives a switch, plus a host-driven "you are hidden, do nothing" signal. |
| **Geometry of a parked tile** | Nothing: a tile undocked from the 56 % pane stays laid out at that size and refits (one ~300 ms WebGL flush) on the next switch to the canvas. | The host owns slot sizes per view: on park it restores the size the *previous* view gave the tile, or fits lazily only when the surface is next shown. |

### Phase 4 — isolated community plugins — as built

Someone outside this repo can ship a view — a Mars base, a city, a game — as a
package that hivemind loads at runtime, without that code ever running in the
privileged renderer. Built from the phase-3 gaps table; every row there is a
message or a host behaviour below.

#### Package format + loading

```
<pkg>/hivemind-view.json      { id, name, version, entry, protocol?, permissions?, assets? }
<pkg>/index.html | dist/x.js  one bundled entry (.html loaded as-is; .js wrapped in a host page)
```

- **Manifest** (`@hivemind/view-sdk/manifest`, `validateViewManifest`): id
  `[a-z0-9-]{2,64}` (directory name, registry id, layout-blob key), semver-ish
  version, a relative entry that cannot leave the package, `protocol` (default
  1; a newer one is refused at load), `permissions` from the known set
  (`workspace:spawn`, `workspace:close`; anything else is refused at install
  AND at load — "requesting an ungranted permission" is a manifest error, not a
  runtime surprise). Every problem is reported, not just the first.
- **Roots** (`@hivemind/core/views`): `$XDG_CONFIG_HOME/hivemind/views/<id>/`
  (installed) and `<repo>/.hivemind/views/<id>/` (shipped with a repo; a user
  package with the same id shadows it). Directory name must equal the manifest
  id once installed.
- **CLI**: `hive views list|install <dir>|remove <id>` (`--json`). Thin: validate
  + copy (`node_modules` skipped). `list` prints exactly what the app will and
  will not load, with the reason. Remove deletes the package only; the plugin's
  layout blob (`hivemind:view-layout:<id>:<repo>`) stays behind, inert.
- **Registry**: main scans on demand (`views:list` IPC, rescanned per repo
  switch and on `hivemind:reload-views`); the renderer registers each loadable
  package as a plugin with `source: "community"`, registration order = after
  the built-ins = ⌘E order. The registry became an external store (`useViews`)
  so switchers re-render when a view appears, disappears, or is disabled.
  Fallback stays the built-in canvas: a disabled or removed view simply stops
  resolving and `resolveViewId` lands on canvas with every session intact.

#### Isolation

- **Origin + scheme.** Packages are served over `hm-view://<id>/<path>` by main
  (`main/view-packages.ts`). Why a scheme and not `file://`: the app page is
  itself `file://` in production, so a file iframe would share the privileged
  origin unless sandboxed; a scheme gives every package a distinct origin
  before the sandbox makes it opaque, lets the renderer CSP say exactly
  `frame-src hm-view:` and nothing else, confines reads to the package dirs of
  the last scan (never a path from the URL — traversal is a 403), and lets
  main stamp a CSP on every response.
- **Sandbox.** `<iframe sandbox="allow-scripts">` — no `allow-same-origin`
  (opaque origin), no forms, popups, top navigation, pointer lock, downloads.
  Electron runs the preload only in the main frame, so there is no
  `window.hive`, no `process`, no `require` (asserted by the e2e suite from
  inside the frame). `parent.document` throws.
- **CSP on the plugin document** (`pluginCsp(nonce)`, one nonce per
  response): `default-src 'none'`; scripts only from `hm-view:` or carrying the
  response nonce — which only the bootstrap page main generates for a `.js`
  entry has, so an inline `<script>` in a plugin's own page does not run (ship
  code as `.js` files); styles/images/fonts/media from `hm-view:` (+ inline
  styles, data/blob); `connect-src 'none'` (no fetch/XHR/WebSocket anywhere —
  `fetch("https://…")` rejects), `frame-src 'none'`, `object-src 'none'`,
  `form-action 'none'`, `base-uri 'none'`. The renderer's own CSP does not allow
  `connect-src hm-view:`, so the host cannot be tricked into fetching plugin
  code either. Files are resolved on their REAL path (`view-package-files.ts`):
  a symlink inside a downloaded package that points outside it is a 403.
- **Process.** Measured, not assumed: the sandboxed frame is an
  out-of-process iframe (its own renderer pid, `WebFrameMain.osProcessId`), so
  a busy loop in a plugin cannot stall the host's main thread at all.
- **One MessagePort.** The host creates a `MessageChannel` on iframe load and
  posts `port2` with a `hivemind-view:port` window message (target `"*"` — the
  frame's origin is opaque, and nothing but the port rides along). Everything
  else is on the port, validated both ways (`@hivemind/view-sdk/protocol`).
- **Validation + thresholds** (`community/host-link.ts`): every inbound message
  is schema-checked before it touches state; commands are checked against the
  granted permissions and against the workspace (unknown tile/frame ids,
  unspawnable kinds are refused); `revealed` must answer an outstanding
  request. Refusals count: ≥ 8 disables the plugin; > 600 messages in one
  second disables it (a flood); > 1.5 s of main-thread long tasks attributed
  to its iframe within 3 s disables it (only reachable if a frame ever runs in
  process); and main's watchdog disables a frame whose process sits at ≥ 60 %
  of a core for three 2 s samples (`views:runaway`). "Disabled" = unregistered
  for the session (a rescan will not bring it back), a toast with the reason,
  the fallback rule.

#### Protocol v1 (the gaps table, made concrete)

| direction | message | phase-3 gap it closes |
|---|---|---|
| host → plugin | `hello {v, pluginId, capabilities, theme, layout, viewport, visible}` | granted permissions; theme colours as `#rrggbb`; the plugin's own persisted blob |
| host → plugin | `structure {frames[{id,title,color:#hex}], tiles[{id,frameId,kind,name}]}` | membership + structure only; colours pre-resolved (`cssColorToHexString`) |
| host → plugin | `names {names}` | name updates separated from structural ones (a title tick never looks structural) |
| host → plugin | `selection {tileId, frameId, fresh}` | `fresh` = changed since the plugin mounted |
| host → plugin | `status {tileId, status}` after `subscribeStatus` | the per-tile stream, bucketed (`idle/working/blocked/exited/unknown`) |
| host → plugin | `reveal {requestId, tileId}` → `revealed {requestId, rect}` | "reveal this tile": plugins own their camera and answer with a rect |
| host → plugin | `resize {w,h}`, `visibility {visible}`, `theme {theme}` | viewport + hidden signal |
| plugin → host | `ready {v}` | version handshake (mismatch disables) |
| plugin → host | `command {name, args}` | exactly the `WorkspaceCommands` vocabulary minus the status functions; `spawnTile` takes kind + frame only |
| plugin → host | `surfaceRects {rects[{tileId,x,y,w,h}]}` (≤ 16) | the hole-punch: the host places a real `<TileSlot>` per rect above the iframe, pointer events only on the slots |
| plugin → host | `framesDrawn {count}` | the render-on-demand counter (≤ 1/s) |
| plugin → host | `layout {data}` (≤ 64 KB) | the plugin's blob, persisted under its id |
| plugin → host | `error {message}` | host log |

**`@hivemind/view-sdk`** (`packages/hive-view-sdk`, dependency-free, browser
TS): `connect()` resolves after `hello`; `on("structure"|"names"|"selection"|
"resize"|"visibility"|"theme")`; `subscribeStatus(tileId, cb)` with ref-
counting; `commands.*` typed and gated locally by the granted permissions;
`setSurfaceRects` (deduplicated); `onReveal`; `reportFrame`; `setLayout`
(debounced); `createInvalidator(client, draw)` — one rAF per burst of
invalidations, nothing while hidden, one catch-up frame on return, every drawn
frame counted. Plugin authors never touch `postMessage`.

#### Performance

- **Compositor.** The World's lesson (a DOM terminal above a full-window GPU
  layer is a blend per repaint) applies to an iframe layer too. When the
  plugin's surfaces form one band flush against an edge — the common dock —
  the iframe is clipped with a rectangular `clip-path: inset(...)`
  (`edge-band.ts`), so the two layers never overlap; a rect clip is a
  compositor clip, not a mask. Floating rects stay plain overlays. The plugin
  still believes it is full-size (it draws under the slot; the pixels are just
  never composited), so nothing in the protocol changes.
- **One commit per frame.** Plugin messages arrive one task each; an undock
  is `selectTile(null)` + `rects: []`. Applied separately, the first deselects
  a still-visible tile — on low-DPI that swaps it from the DOM renderer back
  to WebGL (a GL context + atlas, 0.5 s on software GL) before the second
  parks it. The host batches everything a plugin sends within one animation
  frame into one commit, exactly like a built-in view's own handler.
- **Geometry of a parked tile — fixed** (host, all views): `<TileSlot transient>`
  marks a dock/overlay slot. Leaving it, the surface parks at the size the
  ARRANGING view last gave the tile (`stableSize` in tile-host) and the
  terminal refits at once, hidden, on the cheap DOM renderer the selected tile
  already uses. The next switch to the canvas finds every tile at its size and
  refits nothing. (The first switch after an undock still pays one WebGL
  re-acquire for the tile that was reading on the DOM renderer while docked —
  the canvas's own select→deselect cost, tens of ms on a GPU, 0.1–0.7 s on
  software GL. That is the crisp-boost trade, not geometry.)
- **Runaway containment.** Out-of-process, so a spinning plugin does not touch
  host typing lag (e2e: host event-loop lag p95 ≈ 4 ms with a terminal docked
  by the CPU-burning fixture, on a loaded machine). The flood fixture is
  disabled within ~300 ms; the CPU fixture by main's watchdog. Note for
  headless runs: under xvfb an out-of-process frame's `requestAnimationFrame`
  runs at ~1–2 fps and a spinning frame on a loaded box is descheduled to
  single-digit CPU %, so the suite sets `HIVEMIND_VIEW_RUNAWAY_CPU=1` to prove
  the wiring, not the number.
- **Measured 2026-09-07 (phase 4)** — `scripts/perf-views.mjs` with the
  community scene set, same harness and rig as the phase-3 numbers (xvfb
  1600×1000, software GL, 4 shell tiles × ~50 lines/s). `base` = ce047e4
  (milestone 4, `PERF_SKIP_COMMUNITY=1`), `branch` = this tree; runs alternated
  base/branch, **1-min load 10–36 throughout** (one base run at load 36 is
  excluded from the medians below; treat ±30 % as noise on this rig).

  Canvas / windows / world scenes, medians (2 base, 3 branch): unchanged within
  noise — canvas quiet lag 0.6 / 0.6 ms, canvas streaming lag 7.8 / 6.5 ms,
  typing while streaming 18 / 20 ms, pan 6.5 / 5.3 fps, drag 7.4 / 6.2 fps,
  windows streaming 9.3 / 8.8 fps, switch → windows 326 / 314 ms, → canvas
  336 / 298 ms, canvas quiet CPU 13 / 13.6 %, world docked typing 12.3 / 12.6 ms.

  Community (Orbit) scenes, the three branch runs:

  | metric | run A | run B | run C | acceptance |
  |---|---:|---:|---:|---|
  | orbit quiet · lag p95 / longtasks / **frames drawn** | — | 0.3 ms / 0 / **0** | 0.2 ms / 0 / **0** | render on demand ✓ |
  | orbit quiet CPU vs canvas quiet CPU | — | 14.8 vs 15.1 % | 10.3 vs 12.2 % | within 2 % ✓ (−0.3, −1.9) |
  | orbit streaming, undocked · lag p95 / frames drawn | 15.4 ms / 0 | 6.2 ms / 0 | 18.4 ms / 0 | parked tiles paint nothing ✓ |
  | orbit docked, streaming · lag p95 | 18.1 ms | 15.6 ms | 24.3 ms | — |
  | **typing into the docked tile** vs canvas typing (same run) | **19.9 vs 22.3** (−2.4) | **20.7 vs 11.3** (+9.4) | **32.0 vs 19.8** (+12.2) | within 5 ms: **1 of 3** ✗ |
  | world docked typing, same runs (reference) | 13.1 | 12.6 | 12.0 | |
  | typing with the CPU-burning plugin docked | 25.3 (+3.0) | 16.6 (+5.3) | 29.4 (+9.6) | ≈ the plain dock: the runaway adds nothing ✓ |
  | canvas ↔ orbit plain switch · median → orbit / → canvas · longtask max | 601 / 374 / 135 ms | 393 / 154 / 55 ms | 632 / 755 / 170 ms | → orbit 0 ms on 7 of 8 switches; → canvas like windows (55–170 vs 62–151) ✓ |
  | orbit → canvas right after an undock · longtask | 374 ms | 386 ms | 1014 ms | see below |
  | dock/undock ×6 · longtask max | 58 ms | 53 ms | 129 ms | (World: 486–532) |
  | live xterms after all switches | 4 | 4 | 4 | ✓ |
  | plugin frame pid ≠ host pid | ✓ | ✓ | ✓ | out of process ✓ |

  Reading: everything about the plugin itself is cheap — the scene draws
  nothing while idle, a switch to it costs no host long task, a dock/undock
  cycle is 50–130 ms (the World's is 500 because its scene resizes), and a
  runaway plugin is invisible to host typing. **The one miss is docked typing
  lag**: 8–12 ms above the same run's canvas typing in two runs of three, and
  8–20 ms above the World's dock in the same runs, with no host long tasks
  during typing. Before the `inset()` clip it was 38.8 vs 6.6 ms, so overlap
  was most of it; what is left is plugin-independent (the hostile plugin's dock
  reads the same as Orbit's) and is most likely the cost of compositing a
  second, out-of-process surface under a DOM terminal that repaints ~50×/s on
  a software compositor. On a GPU that composite is trivial; on this rig it is
  not. The follow-up that would remove it on any rig is to SHRINK the iframe
  box for an edge dock rather than clip it — that needs the protocol to carry
  both the plugin's drawable viewport and the full box, so a plugin can still
  place a rect flush against the far edge. Not done in this milestone.

  The switch to the canvas right after an undock still carries one long task
  (370–390 ms in two runs) — per the CPU profile that is `getContext` (the
  docked tile reading on the DOM renderer re-acquires WebGL when it goes back
  to streaming unselected), not a refit; the same profile shows no
  `handleResize` on that switch any more. The World's equivalent measured
  675–845 ms on this tree against 389–504 on the base in the same batch, i.e.
  worse, not better, by one re-acquire's worth; with the profiles showing only
  `getContext` + first render on both sides, the difference is not explained
  and is flagged for the reviewer's own runs on a GPU box.

#### Security checklist

| | |
|---|---|
| sandbox flags | `allow-scripts` only. No same-origin, forms, popups, modals, top-navigation, pointer-lock, downloads. |
| origin | `hm-view://<id>` per package, opaque under the sandbox. `frame-src hm-view:` is the only frame source the app allows; the plugin CSP has `frame-src 'none'`, so it cannot embed anything. |
| CSP (plugin doc) | `default-src 'none'`; `connect-src 'none'`; scripts only from its own scheme or with the per-response nonce (no `unsafe-inline` for scripts); styles/media from its scheme (+ inline styles, data/blob); no objects, forms, base. Stamped by main on every response. |
| filesystem | main serves only files under the package dirs of the last scan, checked on the realpath (`..` and symlinks that leave the package → 403); unknown id → 404. No other IPC reaches a frame (no preload). Unit-tested; the browser's enforcement of the nonce is not unit-testable here (Chromium applies it) — it is covered by the community e2e spec loading the fixtures' external scripts. |
| host API | none. No `window.hive`, `process`, `require`; `parent.document` throws. |
| protocol | every inbound message validated (shape, ids, sizes, permission); ≥ 8 refusals, a flood, or a runaway disables the plugin for the session. |
| what a malicious plugin CAN do | draw anything in its own box; call the granted command vocabulary on real tiles (select/focus always; close/spawn only with the manifest permission the user installed); ask for a live terminal to be placed at a rect (the terminal stays the host's — keystrokes go to the PTY, never to the plugin); burn its own process's CPU until the watchdog drops it; persist ≤ 64 KB under its id. |
| what it CANNOT do | read terminal contents or keystrokes; reach the filesystem, network, PTYs, git, or another plugin; spawn an agent with a command line of its choosing; escape to the app's origin; run code in the host renderer; survive a disable within the session. |
| install trust | `hive views install` copies and validates; it does not sign or scan. A repo-local `.hivemind/views` package is code from that checkout — same sandbox, same rules. |

#### The example: Orbit (`examples/views/orbit`)

Small enough to read in one sitting (`src/main.ts`, ~150 lines, 2D canvas, no
framework): every frame is a sun, its tiles orbit it coloured by status, loose
tiles orbit the centre; hover names a tile (the plugin's own DOM label), click
docks its LIVE terminal in the right half (one `surfaceRects`), click empty
space or Esc undocks, the wheel changes the spread (persisted via `setLayout`).
`node build.mjs` bundles with esbuild into `dist/`; the e2e suite installs
that with the real CLI.

#### What the World would need to become a community plugin

- **A retained GL context across mounts.** The World keeps its `WorldScene`
  (context, programs, geometry) in module state and re-attaches it per mount;
  an iframe is torn down with its view. Phase 5 would need a `hide`/`show`
  lifecycle that keeps the frame alive (and idle) between switches — or accept
  a context + shader compile per switch.
- **A sibling dock pane.** The World's dock is beside the scene (56 %) to keep
  the compositor from blending the terminal over WebGL; a plugin gets the same
  effect for free from the edge-band clip, as long as its dock is flush with
  an edge.
- **`projectTile()` as a test seam** becomes `reveal`; `frameCount` becomes
  `framesDrawn`; `flyToFrame` is plugin-internal; `focusTile` semantics stay
  host-defined.
- **Three.js in the bundle** (~600 KB) — fine, it is the plugin's own chunk.

## Testing

- Unit: `tile-surfaces.test.ts` (repo scoping invariant), `workspace-view.test.ts`
  (registry + fallback + cycle), `view-layout-store.test.ts` (versioned blobs +
  both migrations), `canvas-node-build.test.ts` (shell-only nodes),
  `canvas-persistence.test.ts` (v2 core blob, legacy geometry still readable).
- Unit (phase 4): `packages/hive-view-sdk/tests` (protocol validators both
  directions, manifest, the client over a real MessageChannel),
  `packages/hive-core/src/views.test.ts` (roots, install/remove, shadowing),
  `apps/cli/tests/views.test.ts` (the CLI as a subprocess),
  `community-host-link.test.ts` (ready gate, version mismatch, permission
  gating, id checks, the three thresholds, reveal), `community-edge-band.test.ts`.
- E2E (phase 4): `community-view.spec.ts` — `hive views install` of the built
  Orbit example → ⌘E order → the frame sees no privileged API and no network →
  click a planet docks the same xterm through the hole-punch, typed keys
  arrive, undock parks it, frames are drawn only for changes → the flood and
  CPU fixtures are disabled and the canvas is back with the session intact →
  an unknown permission is refused by install and by the loader → `hive views
  remove` takes the view out of the switcher.
- E2E: `view-switch-preserve.spec.ts` — same xterm and CodeMirror DOM instance
  across canvas → windows → canvas, minimize keeps the surface alive, unsaved
  editor text survives, unknown view id falls back. `windows-view.spec.ts`
  still covers tab behaviour.
