# Pinned tiles and an order the user chose

A plan, not a change. Builds on the view protocol 1.4 doc
(`view-protocol-1.4-2026-09-26.md`).

## 1. Where it stands

**"Pin" already exists and is not a pin.** A tile carries `pinned`, `pinAnchor` and `pinSize`, and
the canvas portals such a tile out of its transformed viewport into a screen-fixed layer
(`canvas-nodes.tsx` → `FloatingPinnedPanel`, `#hm-pinned-layer`). That is **floating**, not
pinning: it says where a tile is drawn on one view, not that the user keeps it within reach.

And it is **canvas-only**. The layer comes from `PinnedLayerContext`, which only `CanvasView`
provides; `TileShell` falls back to an ordinary node when there is none, so in the Windows view
the flag renders nothing, and a plugin view cannot read or set it (`ViewTile` has no field,
`ViewCommands` no command). The Layers rail shows such a tile like any other.

So the word is taken. **Rename it to "float"** — `floating`, `floatAnchor`, `floatSize`,
`FloatToggle`, `#hm-floating-layer` — and, rather than leave it canvas-only, make it the primitive
it already almost is: **a tile the host draws above the view, in screen pixels, whichever view is
mounted.**

That is a one-line change of address, not new machinery. The fixed layer moves out of `CanvasView`
into the workspace shell that hosts every view, and `TileShell` portals into that instead of a
canvas-supplied context. Its three fields stay in core `TileInstance` — they are "where the user
parked this tile on screen", which is not one view's geometry. A floating tile then keeps its place
across a view switch, which is the behaviour you want anyway: the terminal you floated to watch
stays where it is while you change how the rest is arranged.

Tiles saved with the old flag come back as ordinary tiles; float again the ones you want (the
user's call — no key mapping).

"Pin" is then free for the thing it should mean: kept within reach, in every list.

**Order** does not exist at all. The rail lists frames in creation order and each frame's tiles in
the order they were spawned; the projection hands a view the same array. A user cannot move a tile
up, cannot group the two terminals they are actually working in, and cannot move a tile into
another frame from the rail. The only way to reorder anything today is to close tiles and open
them again.

So the work is one idea in three places: **pinned and order are workspace state the host owns, and
every surface — the rail, the canvas, a plugin view — reads and writes the same thing.**

## 2. The model

Two fields on workspace state, next to the tiles themselves:

```ts
/** Tiles the user keeps within reach. Order within the group is the user's too. */
pinnedIds: string[];              // was: `pinned` on each tile
/** The order the user put things in. Ids missing from a list keep creation order, after the
 *  ones named — a new tile appends, and an old workspace opens unchanged. */
order: { frames: string[]; tiles: Record<string /* frameId | "" */, string[]> };
```

Rules that keep this from rotting:

- **The host is the only writer.** The rail, the canvas and a view all go through the same
  workspace commands (`pinTile`, `moveTile`, `reorderTiles`, `reorderFrames`), so two surfaces can
  never disagree about where a tile is.
- **Order is per container.** A tile's order lives under its frame (`""` for loose canvas tiles),
  so moving a tile between frames is a move plus an insert, not a global renumber.
- **Unknown ids are dropped on read, never on write.** A tile that closed leaves its id behind
  until the next write; reading filters. No migration, no cleanup pass.
- **Pinning does not move a tile.** It sets a flag; each surface decides what "within reach" means
  there (§3). Unpinning leaves the tile exactly where it was.

Floating keeps its own three fields (`floating`, `floatAnchor`, `floatSize`) in core state, and the
host — not the view — draws a floating tile. Pinning and floating are independent: a tile can be
both (kept at the top of the rail AND parked on screen), and neither implies the other.

## 3. What each surface does with it

| Surface | Pinned | Order |
|---|---|---|
| **Layers rail** | A `Pinned` group at the top, above `This computer`, with the same rows; a pin glyph on the row and in its right-click menu | Drag a row to reorder within its frame; drop it on a frame row to move it there; drag a frame row to reorder frames |
| **Canvas** | Nothing special — a pinned tile is an ordinary node | The rail's order decides the z-order of overlapping tiles and the order `⌘1…9` / tab-cycling walks them |
| **Windows view** | Pinned tabs first, and they survive "close others" | Tab strip follows the order |
| **A plugin view** | `ViewTile.pinned`, and `pinTile` to set it | `tiles`/`frames` arrive in the host's order; `reorderTiles` / `moveTile` to change it |
| **Any view, floating** | The host draws a floating tile above the view in screen pixels; the view reads `ViewTile.floating`, leaves it out of its own layout, and sends no rect for it | — |

The rail is where the interaction lives, because it is the one surface that already lists
everything in one column. Everything else follows the state.

## 4. Protocol 1.5

`PROTOCOL_VERSION` stays 1; a host lists what it wired in `hello.features` (1.3 §4.0).

| Feature | Wire | Permission |
|---|---|---|
| `pinning` | `ViewTile.pinned?: boolean`; `pinTile(id, pinned)` | `workspace:edit` |
| `ordering` | `structure`'s `frames`/`tiles` come in the user's order; `reorderTiles(frameId, ids)`, `reorderFrames(ids)`, `moveTile(id, frameId)` | `workspace:edit` |
| `floating` | `ViewTile.floating?: boolean`; `floatTile(id, floating)` | `workspace:edit` |

```ts
export interface ViewTile {
  id: string; frameId: string | null; kind: string; name: string;
  agent?: string;
  /** 1.5: the user keeps this tile within reach. */
  pinned?: boolean;
  /** 1.5: the HOST draws this tile, screen-fixed, above your view. Leave it out of your layout
   *  and send no `surfaceRects` entry for it — one sent anyway is ignored. */
  floating?: boolean;
}
export interface ViewCommands {
  /** 1.5, `workspace:edit` */
  pinTile: (id: string, pinned: boolean) => void;
  /** 1.5, `workspace:edit`: move a tile to a frame (null: loose on the canvas). */
  moveTile: (id: string, frameId: string | null) => void;
  /** 1.5, `workspace:edit`: the ids of that container, in the order they should read. Ids the
   *  host does not know are ignored; ids left out keep their place after the ones named. */
  reorderTiles: (frameId: string | null, ids: string[]) => void;
  reorderFrames: (ids: string[]) => void;
  /** 1.5, `workspace:edit`: park a tile on screen (or put it back in the layout). The host owns
   *  where it sits; a view never positions it. */
  floatTile: (id: string, floating: boolean) => void;
}
```

No new permission: `workspace:edit` already covers "rearrange the workspace the user is looking
at" (it renames tiles and binds folders today). All four are structural — they move nothing into
or out of the machine, and they carry no text.

A 1.4 view reads the same `structure` message and simply gets tiles in a nicer order.

## 5. `hive ctl`

`hive ctl pin <tile> [--off]` and `hive ctl move <tile> --frame <id>` fall out of the same
commands, and a supervising agent can then park a tile it is done with. `--json` shapes gain
`pinned` on the tile. Worth doing in the same pass: the control plane and the view protocol have
not diverged so far, and this is the cheapest moment to keep it that way.

## 6. Phases

0. **The rename + the move up.** `pinned`/`pinAnchor`/`pinSize` → `floating`/`floatAnchor`/
   `floatSize`; the fixed layer moves from `CanvasView` to the workspace shell, so floating works
   in the Windows view and in a plugin view, not only on the canvas. UI wording "Float"/"Unfloat".
   No mapping of saved state: an old floating tile opens as an ordinary tile.
1. **State + rail.** `pinnedIds` + `order` in workspace state, the four commands, the pinned group
   and drag-reorder in the rail, canvas z-order follows. Pure ordering helpers
   (`applyOrder(ids, order)`, `insertAt`) live in their own module with unit tests; the rail's
   pointer handling is the only UI code.
2. **Protocol 1.5.** `pinned` + `floating` on `ViewTile`, five commands in the SDK, `pinning` +
   `ordering` + `floating` in `hello.features`, conformance cases, the 1.5 section of the protocol
   doc.
3. **`hive ctl`** + docs (`docs/src/content/docs/guide/`), CHANGELOG.

Each phase ships on its own; 2 and 3 are additive and cannot break a 1.4 view.

## 7. Tests

- **Unit** (the bulk): ordering helpers — ids missing from the order, ids that no longer exist,
  a move between frames, a reorder that names a subset, an empty order (creation order out).
- **E2E** (one spec, the rail): drag a tile above its sibling and it stays there across a view
  switch and a reload; drop it on another frame's row and it moves; pin it and it appears in the
  pinned group and as a floating panel on the canvas.
- **Conformance** (phase 2): a view that sends `reorderTiles` sees the new order in the next
  `structure`; one without `workspace:edit` is refused.

## 8. Decided, so it does not get re-litigated

- **An explicit id list, not a fractional rank.** A workspace holds dozens of tiles, not
  thousands; a list is one write, reads in order, and is obvious in the persisted JSON. A rank
  would buy concurrent inserts nobody makes.
- **Pinning is a flag, not a container.** Making "pinned" a place tiles move into means deciding
  where a tile goes when it is unpinned, and every surface answering that differently.
- **No auto-ordering.** Not by status, not by last use. The order is the user's; a view that wants
  "busiest first" sorts its own copy.
- **The host draws floating tiles, not the view.** A view already only says *where* a tile's live
  surface goes; a floating tile is the same surface with the host supplying the rect. Letting each
  view implement floating would mean four implementations of one screen-fixed layer, and a tile
  that jumps when you switch views.
- **Pinned and floating are separate flags.** They answer different questions ("keep it in my
  list" / "keep it on my screen"), and collapsing them would make unpinning move a tile.
