/**
 * Fireflies' meadow (live/fireflies/meadow): a firefly whose agent needs you flies to its agent's
 * tile and hovers beside it, flashing the call; one whose agent rests settles in the grass and
 * stays; a turn that ends well is a flash the small fireflies answer, nearer ones first, a wave
 * spreading out from it; and the fireflies keep off the tiles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Box } from "../../src/renderer/src/live/scene";
import { Meadow, WAVE_SPEED, type FireflySpec } from "../../src/renderer/src/live/fireflies/meadow";

function seeded(seed: number) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1440;
const H = 900;
const spec = (key: string, mood: FireflySpec["mood"]): FireflySpec => ({ key, kind: "pyralis", size: 1, mood });
function meadow(specs: FireflySpec[], boxes: Box[] = [], seed = 1) {
  seeded(seed);
  const m = new Meadow();
  m.resize(W, H);
  m.setBoxes(boxes);
  m.setRoster(specs, true);
  return m;
}
const run = (m: Meadow, secs: number, each?: () => void) => {
  for (let i = 0; i < secs * 60; i++) {
    m.step(1 / 60);
    each?.();
  }
};

test("a firefly whose agent needs you flies to its tile, hovers by it, and flashes the call: two flashes, again and again", () => {
  for (const seed of [1, 2, 3]) {
    const tile: Box = { x0: 300, y0: 300, x1: 700, y1: 600, key: "t" };
    const m = meadow([spec("t", "cruise")], [tile], seed);
    run(m, 3);
    m.setRoster([spec("t", "surface")]);
    run(m, 8);
    const f = m.flies[0]!;
    let near = 0;
    const lights: number[] = [];
    run(m, 6, () => {
      const d = Math.hypot(Math.max(tile.x0 - f.x, 0, f.x - tile.x1), Math.max(tile.y0 - f.y, 0, f.y - tile.y1));
      if (d < 70) near++;
      lights.push(m.light(f));
    });
    assert.ok(near / (6 * 60) > 0.9, `seed ${seed}: beside its tile ${((near / 360) * 100).toFixed(0)}% of the time`);
    // Its flashes: rises through half its light, about two in each 1.1 s.
    let rises = 0;
    for (let i = 1; i < lights.length; i++) if (lights[i - 1]! < 0.5 && lights[i]! >= 0.5) rises++;
    assert.ok(rises >= 9 && rises <= 12, `seed ${seed}: ${rises} flashes in 6 s`);
  }
});

test("with another tile on the side it would take, a firefly hovers on the other side of its own", () => {
  // Its tile with more room to the right, and another tile just right of it: it hovers on the left.
  const tile: Box = { x0: 300, y0: 300, x1: 600, y1: 520, key: "t" };
  const other: Box = { x0: 610, y0: 250, x1: 900, y1: 560 };
  const m = meadow([spec("t", "cruise")], [tile, other], 2);
  run(m, 2);
  m.setRoster([spec("t", "surface")]);
  run(m, 8);
  const f = m.flies[0]!;
  let left = 0;
  run(m, 5, () => { if (f.x < tile.x0 && f.x > tile.x0 - 80) left++; });
  assert.ok(left / 300 > 0.9, `on its tile's left ${((left / 300) * 100).toFixed(0)}% of the time (at ${f.x.toFixed(0)}, ${f.y.toFixed(0)})`);
});

test("a firefly whose agent rests settles in the grass and stays there", () => {
  const m = meadow([spec("r", "cruise")]);
  run(m, 2);
  m.setRoster([spec("r", "rest")]);
  run(m, 30);
  const f = m.flies[0]!;
  assert.ok(f.y > H * 0.85, `at ${f.y.toFixed(0)}`);
  const [x, y] = [f.x, f.y];
  run(m, 10);
  assert.deepEqual([f.x, f.y], [x, y]);
});

test("a turn that ends well is a flash the small fireflies answer, nearer ones first", () => {
  const m = meadow([spec("a", "cruise")]);
  run(m, 1);
  const f = m.flies[0]!;
  const from = { x: f.x, y: f.y };
  m.finished("a");
  assert.ok(m.light(f) >= 0.99, "it flashes");
  const start = m.time;
  /** When each small firefly answered, and how far it was then. */
  const answered = new Map<(typeof m.motes)[number], { at: number; reach: number }>();
  run(m, 10, () => {
    for (const mote of m.motes) {
      if (mote.answer > 0.95 && !answered.has(mote)) answered.set(mote, { at: m.time - start, reach: Math.hypot(mote.x - from.x, mote.y - from.y) });
    }
  });
  assert.ok(answered.size > m.motes.length * 0.9, `${answered.size} of ${m.motes.length} answered`);
  // Each answers as the wave reaches it.
  for (const { at, reach } of answered.values()) {
    assert.ok(Math.abs(at - reach / WAVE_SPEED) < 0.1, `a firefly ${reach.toFixed(0)} px away answered at ${at.toFixed(2)} s`);
  }
});

test("the fireflies keep off the tiles", () => {
  const boxes: Box[] = [{ x0: 100, y0: 100, x1: 600, y1: 450 }, { x0: 800, y0: 300, x1: 1300, y1: 700 }];
  for (const seed of [1, 2]) {
    const m = meadow(["a", "b", "c", "d"].map((k) => spec(k, "hunt")), boxes, seed);
    let under = 0;
    let all = 0;
    run(m, 60, () => {
      for (const f of m.flies) {
        all++;
        if (boxes.some((b) => f.x > b.x0 && f.x < b.x1 && f.y > b.y0 && f.y < b.y1)) under++;
      }
    });
    assert.ok(under / all < 0.005, `seed ${seed}: under a tile ${((under / all) * 100).toFixed(2)}% of the time`);
  }
  // A tile put down over one: it is out from under it, by the nearest side, in a moment.
  const m = meadow([spec("a", "cruise")]);
  run(m, 2);
  const f = m.flies[0]!;
  const over: Box = { x0: f.x - 20, y0: f.y - 150, x1: f.x + 300, y1: f.y + 150 };
  // Even flying into it, toward somewhere under it.
  f.vx = 30;
  f.vy = 0;
  f.goal = { x: f.x + 200, y: f.y };
  f.goalAt = m.time + 60;
  m.setBoxes([over]);
  run(m, 1.5);
  assert.ok(f.x < over.x0, `still under it, at ${f.x.toFixed(0)} (the tile starts at ${over.x0.toFixed(0)})`);
});
