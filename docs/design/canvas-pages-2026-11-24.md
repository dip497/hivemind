# Canvas pages, drawings in Layers, board access for views, one path for every board action

Status: accepted by the founder 2026-11-24 ("all recommended, do it properly"); the page mode was
replaced on 2026-11-25 (see Choice). Builds on `docs/design/canvas-drawing-2026-11-05.md`.

## Goal

A person can open a box on the canvas into a page of its own, go as deep as they like and come back
by a path at the top; find every drawing and page in Layers; use the same board from a community
view; and do every board action from `hive ctl` exactly as the buttons do it.

## What is there (read 2026-11-24, HEAD 8e71c3c9 + the uncommitted drawing work)

- One Loro doc per workspace (`workspace-host/src/store.ts:163`). Frames are a `LoroTree`
  (`schema.ts`), so frames already nest to any depth in storage; only the layout
  (`frame-layout.ts:345`, "two levels only") and the canvas assume two.
- A tile names its frame (`tiles[id].frame`); a board object names its frame (`frame?`) and is placed
  relative to it. Parent link on the child, as tldraw (`parentId`), Figma and Excalidraw (`frameId`)
  store it.
- The canvas builds every node of the workspace (`canvas-node-build.ts:50`); nothing scopes it.
- Undo is a Loro `UndoManager` per writer with the default 100 steps (`store.ts:566`). The window's
  history is already 100 deep. Host writes (`hive ctl`) use a throwaway writer per call
  (`host/src/board.ts:120`), so nothing an agent or the CLI does can be undone.
- The app's buttons write the doc through `useBoard` → `boardEdit` → `store.editObjects`; the CLI
  goes through `board.*` on the host. Two code paths for the same action.
- Views get `structure` (frames, tiles), never board objects. `store.changed` already carries the
  changed object ids for the board part (`schema.ts:95`), and the view host drops it
  (`host/src/views.ts:217`).
- Limits: `MAX_SHAPES_ON_BOARD = 5000`, checked only in `board.draw`.

## The known problem

A document tree with drill-in navigation (an outliner, a file system) on top of one shared document,
plus a scoped read/write API with change events for plugins.

## What others do

- tldraw: pages are records; shapes point to their parent; the camera and selection are per page and
  per session, never synced; `setCurrentPage` saves and restores them.
  tldraw.dev/sdk-features/pages, tlschema `TLShape.ts`, `TLCamera.ts`.
- Muse and Milanote: a board is a card on its parent; double-click enters; breadcrumbs top left;
  back/forward. help.milanote.com nesting-boards; Muse 3 release notes.
- Figma: loading every page made big files take 20-30 s; plugins had to move to async per-page
  loading (`loadAsync`, `dynamic-page`) and broke. figma.com/plugin-docs/migrating-to-dynamic-loading.
- Miro: `boards:read` / `boards:write` scopes; its update event is geometry-only and local-only,
  which plugin authors work around. developers.miro.com/docs/scopes.
- tldraw `store.listen` / Figma `documentchange`: record-level diffs (added, updated, removed) with
  the origin (local or remote).

## Options

### A. A page is a frame that opens (chosen)

```
frames (LoroTree)           canvas, at "Workspace"        canvas, inside "Payments"
  Payments  {page: true}      [Payments ▸ card]             Workspace › Payments
    Checkout {page: true}     other frames, tiles,          [Checkout ▸ card]  tiles and
  Infra                       drawings of the top           drawings whose frame is
                                                            Payments
```

One new optional field, `FrameRecord.page?: true`. Its members (tiles, board objects, child frames)
are drawn only inside it; on its parent it is a fixed-size card that shows its title and a picture of
what is inside. Which page a window is on, and each page's camera, are the window's own (personal
view layout, never synced).

### B. A page field on everything

`page?: string` on every tile and board object, a page list in `meta`, nesting by `page.parent`.
Two membership ideas (frame and page) on every object; every read filters by both; moving a frame
into a page rewrites all its members.

### C. A Loro doc per page

Each page its own document, loaded when opened. Isolation and lazy loading for free; but an arrow
cannot cross pages, a tile or agent moving page moves between documents, every `hive ctl` address
gains a document, and sync, the phone and the API all learn sub-documents.

### Scale

Numbers: a workspace today has tens of frames and tiles and up to 5000 board objects (the cap).
A shape is about 0.2 KB; a pen stroke up to 2000 points is about 20 KB; take 1 KB average.

| Design | Today (5k objects) | 10x (50k) | 100x (500k) |
|---|---|---|---|
| A | doc ~5 MB, all loaded; canvas builds only the open page's nodes: holds | ~50 MB doc, load ~seconds: bites (cap stops it at 5k today) | does not hold |
| B | same doc size as A; every read filters two fields: holds | as A | does not hold |
| C | ~5 MB split across pages, open page only: holds | holds (only the open page loads) | holds per page; cross-page features gone |

Arithmetic: 5000 × 1 KB = 5 MB; × 10 = 50 MB; Loro imports at roughly 10-50 MB/s on this class of
machine (not measured here), so 50 MB is 1-5 s at open, the Figma failure.

## Choice

Revised 2026-11-25: pages are frames you zoom into. The founder tried the first build, a page as a
separate mode (only its members built, a zero-size origin node, a card on its parent, a camera per
page) and it confused: things disappeared, frames turned into cards, and going to a page from Layers
landed the camera on the zero-size origin, with the diagram's corner mid-screen and no path shown.

A, on one canvas. `FrameRecord.page?: true` stays: it marks a frame as a stop on the path and a row
under Layers' **Pages**. Nothing else about a page differs from a frame: it is drawn, fitted to what
it holds, dragged and nested like any frame (`computeFrameLayout` is recursive, any depth).

- **Going to something** is one function in the window, `flyTo(target)` (`fly-to.ts` for the box,
  `camera-fit.ts` `cameraFor` for the camera): a frame's box, a drawing's union of shape boxes, a
  tile's box, several ids together, a box, or null for everything. The camera fits it in the room the
  widget cards, the tool island and the path bar leave, whole pixels, animated unless reduced motion.
  Layers rows, the path, notifications, `hive ctl focus`, `board --show`, `page open`, fit-all and `.`
  all call it.
- **Inside a frame** is the window's own state (not stored): double-click a page's title (a frame's
  title bar), Enter on a selected frame, a Layers page row or `page open` fly to it and set it. Every
  node outside it gets one class, `hm-outside-focus`, from the set `framesWithin(frames, focused)`,
  found once per change of focus or frames; painted shapes and arrows read the same. The path bar
  shows Workspace › its frames from the top › it. Backspace, Esc, ⌘↑, a path part or a click on the
  canvas outside it go back out; pan and zoom stay free.
- **Spatial rules** take the focused frame's members (at any depth) when the window is inside one,
  else everything: select-all, a drag across the canvas, a new widget's free spot. On the host,
  `page` on `board.read`, `board.picture`, `board.erase`, `--check` and `draw`'s placement means
  "inside that page or frame, at any depth"; left out, the whole canvas. `draw` with `page: null` and
  `board.change` with `page: null` mean "in no page".

Why A over B and C is unchanged: one optional field on a tree that already nests. The cost moves:
every node is built again, as before pages; the cap of 5000 objects bounds it.

## Pre-mortem (a year later, it failed)

1. **Deep frames broke the layout.** `computeFrameLayout` handled two levels. It now recurses: each
   frame wraps its separated children; the anchor's line is pinned at every level.
2. **"I cannot find my agent."** Nothing hides, and every focus goes through `flyTo`.
3. **Plugins tied to the one-document shape.** Views read the board async, all of it or inside a
   page (`board.read({page})`); events carry ids and the nearest page, never the whole board. Known
   ceiling: 5000 objects per workspace; upgrade path is C behind the same API.

## Decisions on the edges

- **Arrows** are drawn whole wherever their ends are; one whose start is outside the focused frame dims.
- **Notes** pinned on the empty canvas show everywhere; `BoardAnchor` has no page.
- **API writer history** is `api:<caller>`, kept while the connection lives and forgotten in the
  domain's `gone(connection)`; a new history excludes every other writer's origin as the window's
  does.
- **The 5000 cap** is in the shared actions (`duplicateObjects`, paste, draw), so no path skips it.
- **Views:** two permissions, as boards elsewhere split read from write: `workspace:board` reads,
  pictures and follows the board; `workspace:draw` draws, changes and erases. A view's writes are its
  own history (`view:<id>`) with `boardUndo`; the person's ⌘Z does not take them back.

- `FrameRecord.page?: true` (`packages/workspace-doc/src/shapes.ts`).
- `packages/workspace-doc/src/pages.ts` (pure): `parentsOf`, `pageOf(frames, frameId)` (the nearest
  page at or above), `isWithin(frames, frameId, container)`, `framesWithin(frames, container)`,
  `ancestorsOf(frames, frameId)`.
- `packages/workspace-doc/src/board-actions.ts` (pure): `lockObjects`, `restack`, `alignObjects`,
  `duplicateObjects`, `styleObjects`, `moveObjects`. `useBoard` and host `board.change` both use these.
- API (`packages/workspace-api`): `board.change` takes `locked`, `stack`, `align`, `duplicate`,
  `page`; `board.undo` / `board.redo`; `board.read` / `board.picture` / `board.erase` take `page`;
  `page.list(repo) => { pages: { id, title, parent, objects, tiles }[] }` (counts at any depth),
  `page.new(repo, { title, in?, at? }) => { id }`, `page.open(repo, id | null) => null` (the window
  flies there and goes inside).
- View protocol 1.20/1.21: `workspace:board`, `workspace:draw`, `boardRead`, `boardPicture`,
  `boardDraw`, `boardChange`, `boardErase`, `boardUndo`, `subscribeBoard`; `ViewFrame.page`.
- CLI: `hive ctl board lock|unlock|front|back|align|duplicate <ids>`, `hive ctl board undo|redo`,
  `hive ctl page list|new|open`, `--page` on `draw`, `board` and `erase`.
- Window: `flyTo`; the focused frame and its path bar (`PagePath.tsx`); Layers lists drawings
  (a click goes to the whole drawing) and pages (a click goes inside).

## Build order

1. Foundation: `page` field, `pages.ts`, `board-actions.ts`, host `board.change` additions, kept
   writer + `board.undo/redo`, `page.*`, `board.read/picture({page})`.
2. The canvas: `flyTo`, the focused frame with its dimming and path bar, recursive frame layout;
   Layers; view protocol; CLI verbs, guide, CHANGELOG.
3. `useBoard` on `board-actions.ts`; typecheck; the drawing e2e and `canvas-pages.spec.ts`.

## Unknown

- Loro import speed for a 50 MB doc on this machine (measure with a generated doc).
- Whether the phone page should show pages (today it shows drawings as pictures; a page list is
  cheap through `page.list`).
