// Pure frame-layout geometry: collision separation + in-frame wrap packing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveFrameCollisions,
  nextSlotInFrame,
  computeFrameLayout,
  arrangeBoxes,
  frameAtPoint,
  FRAME_GAP,
  type FrameGeom,
  type MemberRect,
  type ArrangeBox,
} from "../../src/renderer/src/frame-layout.ts";

const rect = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h });
const apply = (r: { id: string; x: number; y: number; w: number; h: number }, d: { dx: number; dy: number }) =>
  ({ ...r, x: r.x + d.dx, y: r.y + d.dy });
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("non-overlapping frames are left untouched", () => {
  const frames = [rect("a", 0, 0, 500, 400), rect("b", 1000, 0, 500, 400)];
  const d = resolveFrameCollisions(frames);
  assert.deepEqual(d.a, { dx: 0, dy: 0 });
  assert.deepEqual(d.b, { dx: 0, dy: 0 });
});

test("two overlapping frames get separated (no overlap after)", () => {
  // b grew left and now overlaps a.
  const a = rect("a", 0, 0, 800, 400);
  const b = rect("b", 600, 0, 800, 400);
  const d = resolveFrameCollisions([a, b]);
  const a2 = apply(a, d.a);
  const b2 = apply(b, d.b);
  assert.equal(overlap(a2, b2), false, "frames must not overlap after resolve");
});

test("anchor frame stays put; the neighbour yields", () => {
  // 'a' is the frame you just grew → anchor. 'b' must move, not 'a'.
  const a = rect("a", 0, 0, 800, 400);
  const b = rect("b", 600, 0, 800, 400);
  const d = resolveFrameCollisions([a, b], "a");
  assert.deepEqual(d.a, { dx: 0, dy: 0 }, "anchor does not move");
  assert.notDeepEqual(d.b, { dx: 0, dy: 0 }, "neighbour moves");
  assert.equal(overlap(apply(a, d.a), apply(b, d.b)), false);
});

test("separated frames keep at least the gap between them", () => {
  const a = rect("a", 0, 0, 800, 400);
  const b = rect("b", 600, 0, 800, 400);
  const d = resolveFrameCollisions([a, b], "a");
  const b2 = apply(b, d.b);
  // pushed right: b2.x should be >= a.right + gap
  assert.ok(b2.x >= 800 + FRAME_GAP - 1, `expected gap, got b.x=${b2.x}`);
});

test("three-frame cascade fully separates", () => {
  const fs = [
    rect("a", 0, 0, 600, 400),
    rect("b", 300, 0, 600, 400),
    rect("c", 600, 0, 600, 400),
  ];
  const d = resolveFrameCollisions(fs, "a");
  const moved = fs.map((f) => apply(f, d[f.id]!));
  for (let i = 0; i < moved.length; i++)
    for (let j = i + 1; j < moved.length; j++)
      assert.equal(overlap(moved[i]!, moved[j]!), false, `pair ${i},${j} still overlaps`);
});

test("deterministic — same input yields same deltas", () => {
  const fs = [rect("a", 0, 0, 800, 400), rect("b", 500, 100, 800, 400)];
  const d1 = resolveFrameCollisions(fs, "a");
  const d2 = resolveFrameCollisions(fs, "a");
  assert.deepEqual(d1, d2);
});

// ── nextSlotInFrame ────────────────────────────────────────────────────────
const PACK = { padX: 24, padTop: 48, gap: 24, maxRowWidth: 3400 };

test("first tile lands at the frame's top-left pad", () => {
  const slot = nextSlotInFrame({ x: 100, y: 200 }, [], { w: 1200, h: 800 }, PACK);
  assert.deepEqual(slot, { x: 124, y: 248 });
});

test("second tile extends the row to the right when it fits", () => {
  const origin = { x: 100, y: 200 };
  const m = [rect("t1", 124, 248, 1200, 800)];
  const slot = nextSlotInFrame(origin, m, { w: 1200, h: 800 }, PACK);
  assert.equal(slot.x, 124 + 1200 + 24, "snug right of t1");
  assert.equal(slot.y, 248, "top-aligned with the row");
});

test("tile wraps to a new row when the row would exceed maxRowWidth", () => {
  const origin = { x: 100, y: 200 };
  // Two big tiles already fill the row (124..124+1480+24+1480 ≈ 3108); a third
  // 1480 tile would exceed 3400 from leftX → wrap.
  const m = [
    rect("t1", 124, 248, 1480, 1000),
    rect("t2", 124 + 1480 + 24, 248, 1480, 1000),
  ];
  const slot = nextSlotInFrame(origin, m, { w: 1480, h: 1000 }, PACK);
  assert.equal(slot.x, 124, "wraps back to the left pad");
  assert.equal(slot.y, 248 + 1000 + 24, "drops below the tallest in the row");
});

// ── computeFrameLayout (nesting-aware auto-fit) ──────────────────────────────
const K = { pad: 28, header: 36, emptyW: 460, emptyH: 200 };
const mem = (x: number, y: number, w: number, h: number): MemberRect => ({ x, y, r: x + w, b: y + h });
const contains = (
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.w >= inner.x + inner.w &&
  outer.y + outer.h >= inner.y + inner.h;

test("flat: a lone frame fits its member-tile bbox (pad+header)", () => {
  const frames: FrameGeom[] = [{ id: "a", x: 0, y: 0, w: 460, h: 200 }];
  const members = new Map([["a", [mem(100, 100, 500, 400)]]]);
  const { geometry, tileShift } = computeFrameLayout(frames, members, null, K);
  assert.deepEqual(geometry.get("a"), { x: 72, y: 64, w: 556, h: 464 });
  assert.deepEqual(tileShift.get("a"), { dx: 0, dy: 0 });
});

test("flat: an empty frame collapses to the placeholder at its origin", () => {
  const frames: FrameGeom[] = [{ id: "a", x: 300, y: 200, w: 800, h: 600 }];
  const { geometry } = computeFrameLayout(frames, new Map(), null, K);
  assert.deepEqual(geometry.get("a"), { x: 300, y: 200, w: 460, h: 200 });
});

test("flat: two top-level frames with overlapping boxes separate", () => {
  const frames: FrameGeom[] = [
    { id: "a", x: 0, y: 0, w: 800, h: 400 },
    { id: "b", x: 0, y: 0, w: 800, h: 400 },
  ];
  const members = new Map([
    ["a", [mem(0, 0, 800, 400)]],
    ["b", [mem(200, 0, 800, 400)]],
  ]);
  const { geometry } = computeFrameLayout(frames, members, "a", K);
  assert.equal(overlap(geometry.get("a")!, geometry.get("b")!), false);
});

test("nested: a parent frame fully contains its single child frame", () => {
  const frames: FrameGeom[] = [
    { id: "P", x: 0, y: 0, w: 460, h: 200 },
    { id: "C", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P" },
  ];
  // P has no own tiles; C has tiles → C derives its box, P wraps it.
  const members = new Map([["C", [mem(200, 200, 700, 500)]]]);
  const { geometry } = computeFrameLayout(frames, members, null, K);
  const P = geometry.get("P")!;
  const C = geometry.get("C")!;
  assert.ok(contains(P, C), `parent ${JSON.stringify(P)} must contain child ${JSON.stringify(C)}`);
  // The parent reserves header room ABOVE the child for its own title bar.
  assert.ok(P.y < C.y, "parent top sits above child top");
});

test("nested: sibling child frames separate; parent contains both", () => {
  const frames: FrameGeom[] = [
    { id: "P", x: 0, y: 0, w: 460, h: 200 },
    { id: "C1", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P" },
    { id: "C2", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P" },
  ];
  const members = new Map([
    ["C1", [mem(100, 100, 600, 400)]],
    ["C2", [mem(200, 100, 600, 400)]], // overlaps C1's box
  ]);
  const { geometry } = computeFrameLayout(frames, members, "C1", K);
  const P = geometry.get("P")!;
  const C1 = geometry.get("C1")!;
  const C2 = geometry.get("C2")!;
  assert.equal(overlap(C1, C2), false, "siblings must not overlap");
  assert.ok(contains(P, C1) && contains(P, C2), "parent contains both children");
});

test("nested: a parent's separation delta cascades to its child (geometry + tileShift)", () => {
  // Two repo frames, each with one child, positioned so the wrapped parent
  // boxes overlap → top-level separation moves one parent; its child must move
  // with it (same delta) in both geometry and tileShift.
  const frames: FrameGeom[] = [
    { id: "P1", x: 0, y: 0, w: 460, h: 200 },
    { id: "C1", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P1" },
    { id: "P2", x: 0, y: 0, w: 460, h: 200 },
    { id: "C2", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P2" },
  ];
  const members = new Map([
    ["C1", [mem(0, 0, 700, 500)]],
    ["C2", [mem(300, 0, 700, 500)]], // P2's wrapped box overlaps P1's
  ]);
  const { geometry, tileShift } = computeFrameLayout(frames, members, "P1", K);
  assert.equal(overlap(geometry.get("P1")!, geometry.get("P2")!), false, "parents separated");
  // P1 is the anchor → P2 moves. C2 must carry P2's delta.
  const dP2 = tileShift.get("P2")!;
  const dC2 = tileShift.get("C2")!;
  assert.deepEqual(dC2, dP2, "child shift equals parent shift (no children of its own)");
  assert.ok(dP2.dx !== 0 || dP2.dy !== 0, "P2 actually moved");
  assert.ok(contains(geometry.get("P2")!, geometry.get("C2")!), "P2 still contains C2 after move");
});

test("nested: anchoring on a worktree CHILD pins its parent in the top-level pass", () => {
  // Same overlap as above, but the anchor is the worktree child C1 (as happens
  // when you just spawned/dragged a worktree). The top-level pass must pin C1's
  // PARENT (P1) so the nest stays put and the sibling repo (P2) yields.
  const frames: FrameGeom[] = [
    { id: "P1", x: 0, y: 0, w: 460, h: 200 },
    { id: "C1", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P1" },
    { id: "P2", x: 0, y: 0, w: 460, h: 200 },
    { id: "C2", x: 0, y: 0, w: 460, h: 200, parentFrameId: "P2" },
  ];
  const members = new Map([
    ["C1", [mem(0, 0, 700, 500)]],
    ["C2", [mem(300, 0, 700, 500)]],
  ]);
  const { tileShift } = computeFrameLayout(frames, members, "C1", K);
  assert.deepEqual(tileShift.get("P1"), { dx: 0, dy: 0 }, "anchor's parent P1 is pinned");
  assert.deepEqual(tileShift.get("C1"), { dx: 0, dy: 0 }, "the anchored child stays put");
  const dP2 = tileShift.get("P2")!;
  assert.ok(dP2.dx !== 0 || dP2.dy !== 0, "the sibling repo P2 yields instead");
});

// ── arrangeBoxes (opt-in tidy) ───────────────────────────────────────────────
const box = (id: string, x: number, y: number, w: number, h: number): ArrangeBox => ({ id, x, y, w, h });
const ARR = { originX: 100, originY: 200, padX: 24, padTop: 48, gap: 24, maxRowWidth: 1000 };
const noOverlap = (m: Map<string, { x: number; y: number }>, boxes: ArrangeBox[]) => {
  const placed = boxes.map((b) => ({ ...b, ...m.get(b.id)! }));
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      if (overlap(placed[i]!, placed[j]!)) return false;
  return true;
};

test("arrange columns: boxes side by side, top-aligned, in reading order", () => {
  const boxes = [box("b", 500, 200, 200, 150), box("a", 100, 200, 200, 150)];
  const m = arrangeBoxes(boxes, "columns", ARR);
  // sorted by (y,x): a then b. startX=124, startY=248.
  assert.deepEqual(m.get("a"), { x: 124, y: 248 });
  assert.deepEqual(m.get("b"), { x: 124 + 200 + 24, y: 248 });
  assert.ok(noOverlap(m, boxes));
});

test("arrange rows: boxes stacked, left-aligned", () => {
  const boxes = [box("a", 100, 200, 200, 150), box("b", 100, 400, 300, 100)];
  const m = arrangeBoxes(boxes, "rows", ARR);
  assert.deepEqual(m.get("a"), { x: 124, y: 248 });
  assert.deepEqual(m.get("b"), { x: 124, y: 248 + 150 + 24 });
  assert.ok(noOverlap(m, boxes));
});

test("arrange grid: wraps past maxRowWidth, row advances by tallest", () => {
  // maxRowWidth 1000 from startX: two 400-wide fit (424,848), third wraps.
  const boxes = [
    box("a", 0, 0, 400, 200),
    box("b", 500, 0, 400, 120),
    box("c", 1000, 0, 400, 100),
  ];
  const m = arrangeBoxes(boxes, "grid", ARR);
  assert.deepEqual(m.get("a"), { x: 124, y: 248 });
  assert.deepEqual(m.get("b"), { x: 124 + 400 + 24, y: 248 });
  // c wraps to a new row below the tallest in row 1 (200).
  assert.deepEqual(m.get("c"), { x: 124, y: 248 + 200 + 24 });
  assert.ok(noOverlap(m, boxes));
});

// ── frameAtPoint (drop-membership; replaces frame-contains-tile logic) ───────
const wf = (id: string, x: number, y: number, w: number, h: number, parentFrameId?: string) =>
  ({ id, x, y, w, h, parentFrameId });

test("frameAtPoint: a point inside a frame returns that frame + origin", () => {
  const frames = [wf("a", 0, 0, 500, 400)];
  assert.deepEqual(frameAtPoint(frames, 100, 100), { id: "a", x: 0, y: 0 });
});

test("frameAtPoint: a point outside every frame returns null", () => {
  assert.equal(frameAtPoint([wf("a", 0, 0, 100, 100)], 500, 500), null);
});

test("frameAtPoint: INNERMOST (worktree child) wins over its parent at the same point", () => {
  // child 'c' (worktree) sits inside parent 'p'. A drop in the overlap joins 'c'
  // so the tile's PTY runs on the worktree branch — the reviewer's H3 fix.
  const framesZDesc = [wf("c", 50, 50, 200, 200, "p"), wf("p", 0, 0, 800, 600)];
  assert.equal(frameAtPoint(framesZDesc, 100, 100)!.id, "c");
  // A point inside the parent but OUTSIDE the child joins the parent.
  assert.equal(frameAtPoint(framesZDesc, 400, 400)!.id, "p");
});

test("frameAtPoint: among same-level frames, the first (topmost-z) hit wins", () => {
  // Caller passes z-descending; two overlapping top-level frames → first wins.
  const framesZDesc = [wf("top", 0, 0, 300, 300), wf("bottom", 0, 0, 300, 300)];
  assert.equal(frameAtPoint(framesZDesc, 50, 50)!.id, "top");
});
