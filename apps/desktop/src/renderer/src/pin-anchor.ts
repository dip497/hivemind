/**
 * pin-anchor — the pure coordinate math for pinned (viewport-fixed) tiles.
 *
 * A pinned tile's anchor is stored in PANE pixels: the tile's top-left relative
 * to the react-flow container, which is INDEPENDENT of the viewport pan/zoom.
 * To hold that screen pixel as the canvas moves, the tile's flow (canvas)
 * position is recomputed each frame from the anchor + current viewport.
 *
 * react-flow renders a node at pane pixel = viewport.{x,y} + flowPos * zoom, so
 * `paneToFlow` is the exact inverse of `flowToPane` — a round-trip is identity.
 */
export interface Viewport { x: number; y: number; zoom: number }
export interface PaneAnchor { sx: number; sy: number }

/** Flow (canvas) position → pane-pixel anchor under a viewport. */
export function flowToPane(pos: { x: number; y: number }, vp: Viewport): PaneAnchor {
  return { sx: vp.x + pos.x * vp.zoom, sy: vp.y + pos.y * vp.zoom };
}

/** Pane-pixel anchor → flow position under a viewport. Inverse of flowToPane. */
export function paneToFlow(a: PaneAnchor, vp: Viewport): { x: number; y: number } {
  return { x: (a.sx - vp.x) / vp.zoom, y: (a.sy - vp.y) / vp.zoom };
}

/**
 * Keep a pinned tile fully inside the pane. `tile` + `pane` are SCREEN pixels
 * (tile size already scaled by zoom). `margin` reserves an edge gutter (also
 * leaves room for the pin badge that overhangs the top-left corner). When the
 * tile is larger than the pane on an axis, the top-left wins (clamps to margin)
 * so the header + pin control stay reachable instead of scrolling off.
 */
export function clampAnchor(
  a: PaneAnchor,
  tile: { w: number; h: number },
  pane: { w: number; h: number },
  margin = 14,
): PaneAnchor {
  const maxX = Math.max(margin, pane.w - tile.w - margin);
  const maxY = Math.max(margin, pane.h - tile.h - margin);
  return {
    sx: Math.min(Math.max(a.sx, margin), maxX),
    sy: Math.min(Math.max(a.sy, margin), maxY),
  };
}
