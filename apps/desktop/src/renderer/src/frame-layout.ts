/**
 * Pure frame-layout geometry — kept out of Canvas.tsx so it's unit-testable in
 * isolation (no React, no xyflow). Two responsibilities:
 *
 *  1. resolveFrameCollisions — the canvas guarantees frames NEVER overlap. A
 *     frame's geometry is derived from its member tiles' bbox (auto-fit), so
 *     when one frame grows (a tile added/resized) it can expand into a
 *     neighbour. This computes per-frame {dx,dy} nudges that separate every
 *     frame, keeping an anchor (the frame you just touched) fixed so neighbours
 *     yield instead of your focus jumping. The caller applies each delta to the
 *     frame's MEMBER TILES (absolute positions) — auto-fit then re-derives the
 *     frame at the separated spot.
 *
 *  2. nextSlotInFrame — where a newly-spawned tile lands inside a frame. Packs
 *     left-to-right then WRAPS to a new row past a max row width, so a frame
 *     grows downward predictably instead of infinitely rightward.
 */

export interface LayoutRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap kept between separated frames (px). */
export const FRAME_GAP = 28;
/** Max width a row of tiles inside a frame reaches before wrapping (px). Sized
 *  to comfortably hold two large (claude) tiles side by side, then wrap. */
export const FRAME_ROW_MAX = 3400;

/** Do two rects overlap, treating a `gap`-wide margin as "touching"? */
function overlaps(a: LayoutRect, b: LayoutRect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  );
}

const cx = (r: LayoutRect) => r.x + r.w / 2;
const cy = (r: LayoutRect) => r.y + r.h / 2;

/**
 * Compute per-frame {dx,dy} so no two frames overlap (with FRAME_GAP between).
 * - `anchorId` (if present + still in the set) never moves; neighbours yield.
 * - Deterministic: frames processed in a stable order; ties break toward +.
 * - Convergent: each pass pushes the mover out of the smaller-penetration axis
 *   by exactly the penetration depth (+gap). Capped iterations guard against a
 *   pathological cascade; residual overlap (rare) is accepted over a hang.
 * Returns a map id -> {dx,dy}; ids with no movement are present with {0,0}.
 */
export function resolveFrameCollisions(
  input: LayoutRect[],
  anchorId?: string | null,
  gap: number = FRAME_GAP,
): Record<string, { dx: number; dy: number }> {
  // Work on copies; stable order so the result is deterministic.
  const order = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cur = new Map<string, LayoutRect>(order.map((r) => [r.id, { ...r }]));
  const anchorPresent = !!anchorId && cur.has(anchorId);

  const maxIter = Math.max(8, order.length * order.length * 2);
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = cur.get(order[i]!.id)!;
        const b = cur.get(order[j]!.id)!;
        if (!overlaps(a, b, gap)) continue;

        // Penetration depth on each axis (including the gap we want to keep).
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;

        // Pick which one moves: never the anchor. If neither is the anchor,
        // move the later (b) — stable + keeps earlier frames put.
        let mover = b;
        let other = a;
        if (anchorPresent) {
          if (b.id === anchorId) { mover = a; other = b; }
          else { mover = b; other = a; }
          // If BOTH are the anchor that's impossible (unique id); fine.
        }

        if (ox <= oy) {
          const dir = cx(mover) >= cx(other) ? 1 : -1;
          mover.x += dir * ox;
        } else {
          const dir = cy(mover) >= cy(other) ? 1 : -1;
          mover.y += dir * oy;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  const out: Record<string, { dx: number; dy: number }> = {};
  for (const r of input) {
    const c = cur.get(r.id)!;
    out[r.id] = { dx: Math.round(c.x - r.x), dy: Math.round(c.y - r.y) };
  }
  return out;
}

/**
 * Slot for a NEW tile inside a frame. Extends the current top row to the right
 * if the tile still fits within `maxRowWidth` (measured from the leftmost
 * member); otherwise wraps to a fresh row below everything. Top-aligned within
 * a row. `members` are the absolute rects of tiles already in the frame.
 */
export function nextSlotInFrame(
  origin: { x: number; y: number },
  members: LayoutRect[],
  tile: { w: number; h: number },
  opts: { padX: number; padTop: number; gap: number; maxRowWidth?: number },
): { x: number; y: number } {
  const startX = origin.x + opts.padX;
  const startY = origin.y + opts.padTop;
  if (members.length === 0) return { x: startX, y: startY };

  const maxRowWidth = opts.maxRowWidth ?? FRAME_ROW_MAX;
  const leftX = Math.min(...members.map((m) => m.x));
  const rightX = Math.max(...members.map((m) => m.x + m.w));
  const topY = Math.min(...members.map((m) => m.y));
  const botY = Math.max(...members.map((m) => m.y + m.h));

  const candidateX = rightX + opts.gap;
  if (candidateX + tile.w - leftX <= maxRowWidth) {
    // Fits on the current row — top-align with the existing row.
    return { x: candidateX, y: topY };
  }
  // Wrap: new row below everything, back at the left edge.
  return { x: startX, y: botY + opts.gap };
}
