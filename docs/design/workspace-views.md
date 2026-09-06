# Workspace Views — plugin architecture

**Status:** milestone 1 implemented (core/view split, TileHost, canvas + windows
as built-in plugins, versioned per-view layouts, crash fallback).
**Date:** 2026-09-05.

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
  `hivemind:surface-adopted` / `-parked` on the element; `TerminalTile` refits
  once (rAF-coalesced) on adopt, skips its ResizeObserver while parked, and
  ranks a parked tile 0 for the WebGL slot manager.
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

**Switch-path attribution (2026-09-06, CDP CPU profile + `performance.measure`
on 97ab40a).** The review build spent 300–850 ms of main-thread long tasks per
switch. Two causes, both in the fix commit, neither in the pre-fix build:

1. Every terminal got **two fits** per adoption — the explicit refit in
   `onAdopted` plus the `ResizeObserver` fit; ResizeObserver notifications are
   delivered *after* rAF callbacks in the same frame, so the two never
   coalesced. A fit on a WebGL-rendered terminal is an atlas rebuild
   (`WebglRenderer.handleResize`, 100–280 ms each under software GL).
2. That stall starved PTY delivery past the 1.5 s crisp-when-idle threshold:
   background terminals were released to the DOM renderer, then re-acquired
   WebGL on the next output chunk (`getContext` + shader init, 0.4–2.4 s per
   tile here) — a snowball that showed as `data-after-gap 1.8–4.7 s` and 1.1–
   1.7 s long tasks. The forced `offsetWidth` read per slot added 35–55 ms.

Fix: one fit per tile (ResizeObserver only), adoption counts as stream activity
(the quiet timer cannot fire off a switch stall), slot size from the observer
only. Profiler after the fix: 4 fits per switch, zero renderer swaps, zero
output gaps, no forced layouts — the switch's only remaining work is the one
fit per tile the pre-fix build also did (the WebGL atlas rebuild, ~0 on a GPU,
100–600 ms each on swiftshader). The base/branch harness pair could not be
re-taken at low load afterwards (the machine ran a Java/Kafka stack at load
10–24); numbers to re-measure on a quiet box.

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

### Phase 2 — headless layout engines + frame geometry split

- Give a plugin an optional `layout` hook the runtime runs for *every*
  registered plugin regardless of the active view (a headless "layout engine").
  Move `placeInFrame`, auto-fit, arrange and drag-stop into the canvas engine;
  the runtime's `spawnTile` becomes pure core (create tile + membership) and the
  engines react. Delete `canvas-runtime.ts`.
- Split `FrameGeometry` out of `FrameState` into the canvas layout blob (bump
  `CANVAS_LAYOUT.version` to 2 with a migrate).
- Commands grow only as views need them (`renameTile`, `openFile`, …).

### Phase 3 — small Three.js demo view (built-in, privileged)

Register a third built-in plugin `"world"` behind a feature flag:

- A WebGL scene (three + `CSS3DRenderer` for slots). One structure per frame
  (a building / hab module) laid out on a grid, one object per tile inside it;
  colour and animation driven by `agent-status-bus` (working = pulsing,
  blocked = red beacon, exited = dark).
- Selecting an object → `commands.selectTile`; the selected tile's `<TileSlot>`
  is rendered on a `CSS3DObject` facing the camera (one live terminal in the
  scene at a time keeps it cheap; the rest show status). Double-click →
  `commands.focusTile` moves the camera.
- Layout blob: camera pose + per-frame plot coordinates, version 1, `initial`
  auto-placing frames on a spiral so it works on first open.
- Dependency note: `three` is a new renderer dependency; lazy-load the plugin
  chunk so canvas/windows users pay nothing.

### Phase 4 — isolated community plugins

Never load third-party code into the privileged renderer (it has
`window.hive`: PTY spawn, file write, git). The design:

- A community view runs in an **isolated `<webview>`/iframe** with no
  `window.hive`. The host streams it a read-only projection of the model over a
  `MessagePort` (tiles, frames, membership, names, statuses) and accepts a fixed
  command vocabulary back (`selectTile`, `focusTile`, `closeTile`,
  `spawnTile`, `addFrame`) — the same `WorkspaceCommands`, serialized.
- Tile bodies cannot cross the boundary. The plugin declares **surface
  rectangles** (`{ tileId, x, y, w, h }` in its viewport, updated per frame or
  on change); the host renders the real `<TileSlot>`s in an overlay layer
  positioned over those rectangles ("hole-punch"). A plugin that wants a live
  terminal inside a 3D scene projects the object to a screen rect and asks for
  a surface there.
- Manifest (`hivemind-view.json`: id, name, version, entry, permissions) loaded
  from a user directory; registry gains `source: "builtin" | "community"` and the
  fallback rule stays "builtin canvas". Layout blobs are per plugin id, so an
  uninstalled plugin's state is inert, not corrupting.
- Capability gating: default permission set is read-only model + the command
  vocabulary; no fs, no network, no PTY. Anything more is a host feature the
  plugin requests, not code it ships.

## Testing

- Unit: `tile-surfaces.test.ts` (repo scoping invariant), `workspace-view.test.ts`
  (registry + fallback + cycle), `view-layout-store.test.ts` (versioned blobs +
  both migrations), `canvas-node-build.test.ts` (shell-only nodes),
  `canvas-persistence.test.ts` (v2 core blob, legacy geometry still readable).
- E2E: `view-switch-preserve.spec.ts` — same xterm and CodeMirror DOM instance
  across canvas → windows → canvas, minimize keeps the surface alive, unsaved
  editor text survives, unknown view id falls back. `windows-view.spec.ts`
  still covers tab behaviour.
