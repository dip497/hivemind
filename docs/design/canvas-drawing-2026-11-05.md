# Drawing on the canvas

**Decided 2026-11-05.** People and agents draw on the canvas. Shapes are a board object in the workspace document; the canvas stays React Flow.

## Why not tldraw as the canvas

- The SDK's terms allow development only. In an open-source project, "you and your downstream users will require their own" license (tldraw.dev/community/license). Hivemind is MIT.
- Without a valid key, or 30 days after one expires, the editor stops rendering (`LicenseProvider.tsx`, `tldraw@5.6.0`). If it were the canvas, a lapsed key would take the terminals with it.
- It would replace 11 source files and 584 selector uses across 154 e2e specs.
- A view plugin cannot do it: at most 16 surface holes against 58 tiles on the maintainer's board, and nothing draws over a hole.

## What was taken from tldraw's agent work

From the MIT agent kit and tldraw's blog: create, update and delete as the verbs; an overview and a full reading; a picture to check the result; lints (`overlaps`); notes pinned where an agent cannot otherwise point.

## The shape of it

- **One owner.** `ShapeObject` in `workspace-doc`, written by `editObjects`: merged, undone and synced like a note. `drawing.ts` is pure: placing, outlines, hit testing, the picture.
- **The host places what an agent draws** (`packages/host/src/board.ts`), so it works with no window and on `hive host`.
- **Shapes are React Flow nodes.** A node gets drag, resize, frame membership and arrows for free. One not selected reads no board state, so it draws again only when it changes. Arrows stay `ArrowObject`, bound to what they end on; a line with a head covers a free end.
- **Notes are review comments** with a place on the board (`BoardComment`), so `hive review`, `hive ctl notes` and the phone's list answer them.
- **The phone is sent a picture**, an SVG the host draws, shown as an image: nothing of it runs, and no renderer ships on the page.

## Ceilings

- 500 things per `board.draw`, 5000 shapes per board for agents, 2000 points per stroke. A person's own drawing is not capped.
- Every shape is a DOM node, and react-flow's list is walked per drag frame. See the measurements in the PR; past the ceiling, cull or draw shapes on one canvas.
- Grouping is by `drawing`: there is no nesting.
- Layout is a plain layered one, not edge routing: arrows may cross a box in a dense graph.
