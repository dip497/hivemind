import type { SurfaceRect } from "@hivemind/view-sdk/protocol";

/** `inset(...)` excluding the surfaces when they form a band flush against
 *  one edge of the `w×h` box (full height for left/right, full width for
 *  top/bottom); null otherwise. Pure; unit-tested. */
export function edgeBandClip(rects: SurfaceRect[], { w, h }: { w: number; h: number }): string | null {
  if (rects.length === 0 || w <= 0 || h <= 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const tol = 1;
  const fullH = y0 <= tol && y1 >= h - tol;
  const fullW = x0 <= tol && x1 >= w - tol;
  if (fullH && x1 >= w - tol && x0 > tol) return `inset(0 ${Math.round(w - x0)}px 0 0)`;   // right band
  if (fullH && x0 <= tol && x1 < w - tol) return `inset(0 0 0 ${Math.round(x1)}px)`;       // left band
  if (fullW && y1 >= h - tol && y0 > tol) return `inset(0 0 ${Math.round(h - y0)}px 0)`;   // bottom band
  if (fullW && y0 <= tol && y1 < h - tol) return `inset(${Math.round(y1)}px 0 0 0)`;       // top band
  return null;
}

