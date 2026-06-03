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
 *
 *  3. computeFrameLayout — the whole-canvas auto-fit, nesting-aware. Derives
 *     every frame's geometry from its member tiles AND (for a repo frame that
 *     owns worktree sub-frames) the bounding box of its child frames, then
 *     separates frames so siblings never overlap — but a child stays nested
 *     inside its parent. Pure: the React effect feeds it member rects and
 *     commits the geometry + member-tile shifts it returns.
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

// ── nesting-aware whole-canvas auto-fit ─────────────────────────────────────

/** A frame's stored geometry (absolute x/y). `parentFrameId` set => this is a
 *  worktree sub-frame nested inside that repo frame. */
export interface FrameGeom {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentFrameId?: string;
}

/** Absolute bounding box of one member tile (right/bottom precomputed). */
export interface MemberRect { x: number; y: number; r: number; b: number }

/** Padding/sizing knobs — passed in so Canvas owns the single source of truth
 *  for FRAME_PAD/FRAME_HEADER/etc. and this stays pure. */
export interface FrameLayoutConst {
  /** Side + bottom padding from member tiles to the frame edge. */
  pad: number;
  /** Header bar height — room reserved above member tiles. */
  header: number;
  /** Collapsed placeholder size for an empty frame. */
  emptyW: number;
  emptyH: number;
  /** Gap between separated sibling frames. Default FRAME_GAP. */
  gap?: number;
  /** Extra inset a parent repo frame keeps around its nested child frames
   *  (on top of its own header room). Default = pad. */
  nestPad?: number;
}

interface Rect { x: number; y: number; w: number; h: number }

/** Bounding box of member tiles for one frame, padded to frame edges. Empty
 *  members → a collapsed placeholder anchored at the frame's current origin. */
function tileBox(f: FrameGeom, mem: MemberRect[] | undefined, k: FrameLayoutConst): Rect {
  if (!mem || mem.length === 0) return { x: f.x, y: f.y, w: k.emptyW, h: k.emptyH };
  const minX = Math.min(...mem.map((m) => m.x));
  const minY = Math.min(...mem.map((m) => m.y));
  const maxR = Math.max(...mem.map((m) => m.r));
  const maxB = Math.max(...mem.map((m) => m.b));
  return {
    x: Math.round(minX - k.pad),
    y: Math.round(minY - k.header),
    w: Math.round(maxR - minX + k.pad * 2),
    h: Math.round(maxB - minY + k.header + k.pad),
  };
}

/**
 * Whole-canvas frame geometry, nesting-aware.
 *
 * Two levels only (repo frame → worktree sub-frames). The algorithm:
 *   1. Every frame's tile-derived box (`tileBox`).
 *   2. Separate each parent's CHILD frames among themselves (a sibling group),
 *      keeping the anchor fixed — children never overlap each other.
 *   3. Each parent's box = union(its own tiles, its children's separated
 *      boxes) inset by `nestPad` + header room, so children sit visually
 *      inside the parent below its title bar.
 *   4. Separate the TOP-LEVEL frames among themselves. A parent's delta
 *      cascades to its children (geometry + tile shift) so the nest moves as
 *      one body.
 *
 * Returns final per-frame geometry plus, per frame, the {dx,dy} the caller
 * must apply to that frame's MEMBER TILES (absolute) so the next derive lands
 * the frame at the separated spot. For a child frame this shift already folds
 * in its parent's delta.
 */
export function computeFrameLayout(
  frames: FrameGeom[],
  memberRects: Map<string, MemberRect[]>,
  anchorId: string | null | undefined,
  k: FrameLayoutConst,
): {
  geometry: Map<string, Rect>;
  tileShift: Map<string, { dx: number; dy: number }>;
} {
  const gap = k.gap ?? FRAME_GAP;
  const nestPad = k.nestPad ?? k.pad;
  const byId = new Map(frames.map((f) => [f.id, f]));
  // A parentFrameId that points at a missing frame ⇒ treat as top-level.
  const parentOf = (f: FrameGeom) =>
    f.parentFrameId && byId.has(f.parentFrameId) ? f.parentFrameId : undefined;

  const childrenOf = new Map<string, FrameGeom[]>();
  for (const f of frames) {
    const p = parentOf(f);
    if (p) (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(f);
  }

  // 1) tile-derived box for every frame.
  const tBox = new Map<string, Rect>();
  for (const f of frames) tBox.set(f.id, tileBox(f, memberRects.get(f.id), k));

  // 2) separate sibling child frames within each parent.
  const childDelta = new Map<string, { dx: number; dy: number }>();
  for (const [, kids] of childrenOf) {
    if (kids.length < 2) continue; // a lone child can't collide
    const rects: LayoutRect[] = kids.map((c) => ({ id: c.id, ...tBox.get(c.id)! }));
    const d = resolveFrameCollisions(rects, anchorId, gap);
    for (const c of kids) childDelta.set(c.id, d[c.id] ?? { dx: 0, dy: 0 });
  }
  const childBox = (id: string): Rect => {
    const b = tBox.get(id)!;
    const d = childDelta.get(id) ?? { dx: 0, dy: 0 };
    return { x: b.x + d.dx, y: b.y + d.dy, w: b.w, h: b.h };
  };

  // 3) parent (top-level) desired box wraps own tiles + child boxes.
  const topLevel = frames.filter((f) => !parentOf(f));
  const rootDesired = new Map<string, Rect>();
  for (const f of topLevel) {
    const kids = childrenOf.get(f.id);
    const boxes: Rect[] = [];
    const ownHasTiles = (memberRects.get(f.id)?.length ?? 0) > 0;
    if (ownHasTiles) boxes.push(tBox.get(f.id)!);
    if (kids) for (const c of kids) boxes.push(childBox(c.id));
    if (boxes.length === 0) {
      // No tiles, no children → collapsed placeholder at current origin.
      rootDesired.set(f.id, { x: f.x, y: f.y, w: k.emptyW, h: k.emptyH });
      continue;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxR = Math.max(...boxes.map((b) => b.x + b.w));
    const maxB = Math.max(...boxes.map((b) => b.y + b.h));
    if (kids?.length) {
      // Inset around the nest + extra header room so the parent title bar
      // clears the child frames sitting below it.
      rootDesired.set(f.id, {
        x: minX - nestPad,
        y: minY - k.header,
        w: maxR - minX + nestPad * 2,
        h: maxB - minY + k.header + nestPad,
      });
    } else {
      rootDesired.set(f.id, { x: minX, y: minY, w: maxR - minX, h: maxB - minY });
    }
  }

  // 4) separate the top-level frames.
  const rootRects: LayoutRect[] = topLevel.map((f) => ({ id: f.id, ...rootDesired.get(f.id)! }));
  const rootDelta = resolveFrameCollisions(rootRects, anchorId, gap);

  // 5) assemble final geometry + per-frame member-tile shift.
  const geometry = new Map<string, Rect>();
  const tileShift = new Map<string, { dx: number; dy: number }>();
  for (const f of topLevel) {
    const dp = rootDelta[f.id] ?? { dx: 0, dy: 0 };
    const r = rootDesired.get(f.id)!;
    geometry.set(f.id, { x: r.x + dp.dx, y: r.y + dp.dy, w: r.w, h: r.h });
    tileShift.set(f.id, dp);
    for (const c of childrenOf.get(f.id) ?? []) {
      const dc = childDelta.get(c.id) ?? { dx: 0, dy: 0 };
      const total = { dx: dp.dx + dc.dx, dy: dp.dy + dc.dy };
      const cb = tBox.get(c.id)!;
      geometry.set(c.id, { x: cb.x + total.dx, y: cb.y + total.dy, w: cb.w, h: cb.h });
      tileShift.set(c.id, total);
    }
  }
  return { geometry, tileShift };
}
