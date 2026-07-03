/**
 * pin-anchor — the pure geometry for pinned (screen-fixed) tiles.
 *
 * A pinned tile is a TRUE screen-fixed floating panel: its content is portaled
 * out of react-flow's transformed viewport into a fixed full-window layer, so it
 * holds a constant screen position + size regardless of canvas pan/zoom. Its
 * anchor is therefore stored in plain SCREEN pixels (viewport coordinates — the
 * panel's top-left), NOT pane/flow pixels. No counter-translate math is needed;
 * the only geometry left is clamping the panel inside the window.
 */
export interface ScreenAnchor { sx: number; sy: number }

/**
 * Keep a pinned panel fully inside the window. `tile` + `window` are SCREEN
 * pixels. `margin` reserves an edge gutter (also leaves room for the header
 * controls that overhang the top-left corner). When the panel is larger than the
 * window on an axis, the top-left wins (clamps to margin) so the header + unpin
 * control stay reachable instead of scrolling off.
 */
export function clampAnchor(
  a: ScreenAnchor,
  tile: { w: number; h: number },
  window: { w: number; h: number },
  margin = 14,
): ScreenAnchor {
  const maxX = Math.max(margin, window.w - tile.w - margin);
  const maxY = Math.max(margin, window.h - tile.h - margin);
  return {
    sx: Math.min(Math.max(a.sx, margin), maxX),
    sy: Math.min(Math.max(a.sy, margin), maxY),
  };
}
