// Pure frame-layout geometry: collision separation + in-frame wrap packing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveFrameCollisions,
  nextSlotInFrame,
  FRAME_GAP,
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
