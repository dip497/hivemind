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
 *  4. arrangeBoxes — opt-in "tidy" for a frame's contents (tiles + worktree
 *     sub-frames). Free drag stays the default; this snaps the boxes into
 *     Columns / Rows / Grid only when the user asks. Pure: returns new absolute
 *     top-lefts; the caller applies them.
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

  // Bound the work: separation converges in a handful of passes in practice, so
  // the n²-per-pass scan times an n²-iteration cap (O(n⁴)) is needless on a busy
  // board. Keep the quadratic iteration room for tiny sets (cheap + helps tight
  // cascades) but hard-cap it so large boards can't spike the auto-fit effect.
  const maxIter = Math.min(Math.max(8, order.length * order.length * 2), 96);
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
 * Separate a group of SIBLING frames (worktree children of one repo frame),
 * returning per-frame {dx,dy}. Two strategies:
 *
 *  - ≤2 frames, or already non-overlapping: fall back to
 *    `resolveFrameCollisions` — a minimal nudge that keeps the anchor put and
 *    barely moves a neighbour. This preserves free-drag placement.
 *
 *  - 3+ OVERLAPPING frames: pairwise nudging picks the smaller-penetration axis
 *    per collision, which for a row of grown frames scatters them into a diagonal
 *    stagger (one wraps down, the next stays right, …) — the "nested layers get
 *    lost / dispersed" bug. Instead reflow them into a stable left→right row
 *    that wraps past FRAME_ROW_MAX, in READING ORDER of their current top-lefts,
 *    anchored at the GROUP's top-left (not the anchor's) so the reflow's origin
 *    is independent of which sibling happens to be the anchor — the anchor's
 *    slot is still respected via the reading-order sort, which is derived from
 *    current positions.
 *
 * Pure — returns deltas; the caller applies them (to member tiles).
 */
function separateSiblingFrames(
  rects: LayoutRect[],
  anchorId: string | null | undefined,
  gap: number,
): Record<string, { dx: number; dy: number }> {
  const anyOverlap = (() => {
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        if (overlaps(rects[i]!, rects[j]!, gap)) return true;
    return false;
  })();
  // ≤2 frames, or nothing overlaps: the minimal-nudge separator is ideal — it
  // respects free-drag positions and only moves what must move.
  if (rects.length <= 2 || !anyOverlap) return resolveFrameCollisions(rects, anchorId, gap);

  // 3+ overlapping: reflow into a stable wrapping row in reading order. Origin
  // = the group's current top-left, regardless of which rect is the anchor —
  // bucket the y term so siblings a few px apart in top don't flip reading order.
  const sorted = [...rects].sort(
    (a, b) => (Math.round(a.y / 64) - Math.round(b.y / 64)) || a.x - b.x || (a.id < b.id ? -1 : 1),
  );
  const originX = Math.min(...rects.map((r) => r.x));
  const originY = Math.min(...rects.map((r) => r.y));
  const out: Record<string, { dx: number; dy: number }> = {};
  let x = originX, y = originY, rowH = 0;
  for (const r of sorted) {
    if (x > originX && x + r.w - originX > FRAME_ROW_MAX) { x = originX; y += rowH + gap; rowH = 0; }
    out[r.id] = { dx: Math.round(x - r.x), dy: Math.round(y - r.y) };
    x += r.w + gap;
    if (r.h > rowH) rowH = r.h;
  }
  return out;
}

/**
 * First free slot for a NEW tile inside a frame. Beside `near` (the tile that
 * opened it) when that is free, right of it and then below it; otherwise fill
 * gaps in reading order, left to right and then down, within the preferred row
 * width. `members` are the absolute rects of tiles already in the frame.
 */
export function nextSlotInFrame(
  origin: { x: number; y: number },
  members: LayoutRect[],
  tile: { w: number; h: number },
  opts: { padX: number; padTop: number; gap: number; maxRowWidth?: number; near?: LayoutRect },
): { x: number; y: number } {
  const startX = origin.x + opts.padX;
  const startY = origin.y + opts.padTop;
  const n = opts.near;
  if (n) {
    for (const c of [{ x: n.x + n.w + opts.gap, y: n.y }, { x: n.x, y: n.y + n.h + opts.gap }]) {
      if (!members.some((m) => overlaps({ id: "", ...c, ...tile }, m, opts.gap))) return c;
    }
  }
  const rightLimit = startX + Math.max(opts.maxRowWidth ?? FRAME_ROW_MAX, tile.w);
  // A free rectangle can start at the pad or just below an occupant. For each
  // row, skip directly past boxes that block it instead of probing every pixel.
  const rows = [...new Set([startY, ...members.map((m) => m.y + m.h + opts.gap).filter((y) => y >= startY)])].sort((a, b) => a - b);
  for (const y of rows) {
    let x = startX;
    while (x + tile.w <= rightLimit) {
      let blockedUntil = x;
      for (const m of members) {
        const vertical = y + tile.h + opts.gap > m.y && m.y + m.h + opts.gap > y;
        const horizontal = x + tile.w + opts.gap > m.x && m.x + m.w + opts.gap > x;
        if (vertical && horizontal) blockedUntil = Math.max(blockedUntil, m.x + m.w + opts.gap);
      }
      if (blockedUntil === x) return { x, y };
      x = blockedUntil;
    }
  }
  // The last candidate is below every member and always has room.
  return { x: startX, y: Math.max(startY, ...members.map((m) => m.y + m.h + opts.gap)) };
}

/** Reserve a tile's box before React commits the tile and canvas position. */
export function reserveTileSlot(
  id: string,
  origin: { x: number; y: number },
  members: LayoutRect[],
  pending: Map<string, LayoutRect>,
  tile: { w: number; h: number },
  opts: { padX: number; padTop: number; gap: number; maxRowWidth?: number; near?: LayoutRect },
): { x: number; y: number } {
  const slot = nextSlotInFrame(origin, [...members, ...[...pending.values()].filter((r) => r.id !== id)], tile, opts);
  pending.set(id, { id, ...slot, ...tile });
  return slot;
}

// ── opt-in arrange (Columns / Rows / Grid) ──────────────────────────────────

export type ArrangeMode = "columns" | "rows" | "grid";

/** A box to arrange — a member tile or a worktree sub-frame, by absolute rect. */
export interface ArrangeBox { id: string; x: number; y: number; w: number; h: number }

/**
 * Tidy a frame's contents into the chosen layout, returning each box's new
 * absolute top-left. Boxes are taken in reading order (top→bottom, left→right)
 * so the result is stable and matches what the user sees.
 *  - columns: one horizontal band, boxes side by side, top-aligned.
 *  - rows:    one vertical stack, boxes left-aligned.
 *  - grid:    pack left→right, wrapping to a new row past maxRowWidth; each row
 *             advances by its tallest box.
 * Pure — no overlap because every box gets a fresh slot.
 */
export function arrangeBoxes(
  boxes: ArrangeBox[],
  mode: ArrangeMode,
  opts: { originX: number; originY: number; padX: number; padTop: number; gap: number; maxRowWidth?: number },
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const startX = opts.originX + opts.padX;
  const startY = opts.originY + opts.padTop;

  if (mode === "rows") {
    let y = startY;
    for (const b of sorted) {
      out.set(b.id, { x: startX, y });
      y += b.h + opts.gap;
    }
  } else if (mode === "columns") {
    let x = startX;
    for (const b of sorted) {
      out.set(b.id, { x, y: startY });
      x += b.w + opts.gap;
    }
  } else {
    const maxW = opts.maxRowWidth ?? FRAME_ROW_MAX;
    let x = startX, y = startY, rowH = 0;
    for (const b of sorted) {
      if (x > startX && x + b.w - startX > maxW) { x = startX; y += rowH + opts.gap; rowH = 0; }
      out.set(b.id, { x, y });
      x += b.w + opts.gap;
      if (b.h > rowH) rowH = b.h;
    }
  }
  return out;
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
  // Single pass — `Math.min(...mem.map())` four times allocates four arrays per
  // frame per layout tick (hot path). One reduce, no intermediates.
  let minX = Infinity, minY = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const m of mem) {
    if (m.x < minX) minX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.r > maxR) maxR = m.r;
    if (m.b > maxB) maxB = m.b;
  }
  return {
    x: Math.round(minX - k.pad),
    y: Math.round(minY - k.header),
    // Never narrower than an empty frame: its header's chrome needs that much, and a small
    // member (a sticky note) would otherwise squeeze it out of the frame.
    w: Math.max(k.emptyW, Math.round(maxR - minX + k.pad * 2)),
    h: Math.round(maxB - minY + k.header + k.pad),
  };
}

/**
 * Whole-canvas frame geometry, nesting-aware, to any depth.
 *
 * The algorithm, from the innermost frames out:
 *   1. Every frame's tile-derived box (`tileBox`).
 *   2. Separate each frame's CHILD frames among themselves (a sibling group),
 *      keeping the anchor's line fixed — children never overlap each other.
 *   3. A frame with children wraps (its own tiles, its children's separated
 *      boxes) inset by `nestPad` + header room, so children sit visually
 *      inside it below its title bar.
 *   4. Separate the TOP-LEVEL frames among themselves. Each delta cascades to
 *      everything inside (geometry + tile shift) so the nest moves as one body.
 *
 * Returns final per-frame geometry plus, per frame, the {dx,dy} the caller
 * must apply to that frame's MEMBER TILES (absolute) so the next derive lands
 * the frame at the separated spot. For a nested frame this shift already folds
 * in every delta above it.
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

  // At each level the anchor's line is pinned: the anchor itself, or the frame holding it there,
  // so spawning or dragging in a nested frame never makes the nest jump against a sibling.
  const anchorLine = new Set<string>();
  for (let a = anchorId ? byId.get(anchorId) : undefined, steps = 0; a && steps <= frames.length; steps++) {
    anchorLine.add(a.id);
    const p = parentOf(a);
    a = p ? byId.get(p) : undefined;
  }
  const pinnedIn = (group: FrameGeom[]) => group.find((f) => anchorLine.has(f.id))?.id ?? anchorId;

  // 1–3) each frame's desired box, children first; each child's delta inside its parent.
  const desired = new Map<string, Rect>();
  const childDelta = new Map<string, { dx: number; dy: number }>();
  const visiting = new Set<string>();
  const boxOf = (f: FrameGeom): Rect => {
    const known = desired.get(f.id);
    if (known) return known;
    visiting.add(f.id);
    const kids = (childrenOf.get(f.id) ?? []).filter((c) => !visiting.has(c.id));
    const own = tileBox(f, memberRects.get(f.id), k);
    let box = own;
    if (kids.length > 0) {
      const rects: LayoutRect[] = kids.map((c) => ({ id: c.id, ...boxOf(c) }));
      const d = kids.length > 1 ? separateSiblingFrames(rects, pinnedIn(kids), gap) : {};
      const boxes: Rect[] = (memberRects.get(f.id)?.length ?? 0) > 0 ? [own] : [];
      for (const r of rects) {
        const dc = d[r.id] ?? { dx: 0, dy: 0 };
        childDelta.set(r.id, dc);
        boxes.push({ x: r.x + dc.dx, y: r.y + dc.dy, w: r.w, h: r.h });
      }
      const minX = Math.min(...boxes.map((b) => b.x));
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxR = Math.max(...boxes.map((b) => b.x + b.w));
      const maxB = Math.max(...boxes.map((b) => b.y + b.h));
      // Inset around the nest + extra header room so the title bar clears the frames below it.
      box = { x: minX - nestPad, y: minY - k.header, w: maxR - minX + nestPad * 2, h: maxB - minY + k.header + nestPad };
    }
    visiting.delete(f.id);
    desired.set(f.id, box);
    return box;
  };

  // 4) separate the top-level frames.
  const topLevel = frames.filter((f) => !parentOf(f));
  const rootRects: LayoutRect[] = topLevel.map((f) => ({ id: f.id, ...boxOf(f) }));
  const rootDelta = resolveFrameCollisions(rootRects, pinnedIn(topLevel), gap);

  // 5) assemble final geometry + per-frame member-tile shift, every delta above folded in.
  const geometry = new Map<string, Rect>();
  const tileShift = new Map<string, { dx: number; dy: number }>();
  const place = (f: FrameGeom, total: { dx: number; dy: number }) => {
    if (geometry.has(f.id)) return;
    const r = desired.get(f.id)!;
    geometry.set(f.id, { x: r.x + total.dx, y: r.y + total.dy, w: r.w, h: r.h });
    tileShift.set(f.id, total);
    for (const c of childrenOf.get(f.id) ?? []) {
      if (!desired.has(c.id)) continue;
      const dc = childDelta.get(c.id) ?? { dx: 0, dy: 0 };
      place(c, { dx: total.dx + dc.dx, dy: total.dy + dc.dy });
    }
  };
  for (const f of topLevel) place(f, rootDelta[f.id] ?? { dx: 0, dy: 0 });
  return { geometry, tileShift };
}

/** Which frame contains the point (cx,cy)? Prefers the INNERMOST frame — a
 *  worktree child sits geometrically inside its repo parent, so a tile dropped
 *  there must join the CHILD (its PTY runs on the worktree's branch/cwd), not
 *  the parent. Among frames as deep, the first hit wins, so pass the frames
 *  z-DESCENDING for topmost-wins. Pure; used for drop-membership. */
export function frameAtPoint(
  framesZDesc: Array<{ id: string; x: number; y: number; w: number; h: number; parentFrameId?: string }>,
  cx: number,
  cy: number,
): { id: string; x: number; y: number } | null {
  const hit = (f: { x: number; y: number; w: number; h: number }) =>
    cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
  const byId = new Map(framesZDesc.map((f) => [f.id, f]));
  const depthOf = (f: { parentFrameId?: string }) => {
    let d = 0;
    for (let p = f.parentFrameId ? byId.get(f.parentFrameId) : undefined; p && d <= framesZDesc.length; p = p.parentFrameId ? byId.get(p.parentFrameId) : undefined) d++;
    return d;
  };
  let best: { f: (typeof framesZDesc)[number]; d: number } | null = null;
  for (const f of framesZDesc) {
    if (!hit(f)) continue;
    const d = depthOf(f);
    if (!best || d > best.d) best = { f, d };
  }
  return best ? { id: best.f.id, x: best.f.x, y: best.f.y } : null;
}
