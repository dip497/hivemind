/**
 * Jellyfish's water (live/jelly/swarm): a jelly whose agent needs you comes up over its agent's tile
 * and holds there; one whose agent rests sinks low; the others keep to the water between the tiles;
 * a closed agent's jelly swims off and is gone; a turn that ends well is a flash that fades; and the
 * marine snow keeps falling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Box } from "../../src/renderer/src/live/scene";
import { Swarm, type JellySpec } from "../../src/renderer/src/live/jelly/swarm";

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
const spec = (key: string, mood: JellySpec["mood"], kind: JellySpec["kind"] = "moon"): JellySpec => ({ key, kind, size: 1, mood });

function sea(specs: JellySpec[], boxes: Box[] = [], seed = 1) {
  seeded(seed);
  const s = new Swarm();
  s.resize(W, H);
  s.setBoxes(boxes);
  s.setRoster(specs, true);
  return s;
}
const run = (s: Swarm, secs: number, each?: () => void) => {
  for (let i = 0; i < secs * 60; i++) {
    s.step(1 / 60);
    each?.();
  }
};

test("a jelly whose agent needs you comes up over its tile and holds there, its tentacles above the tile", () => {
  for (const seed of [1, 2, 3]) {
    for (const kind of ["moon", "nettle", "box"] as const) {
      const tile: Box = { x0: 500, y0: 520, x1: 900, y1: 800, key: "t" };
      const s = sea([spec("t", "cruise", kind)], [tile], seed);
      run(s, 2);
      s.setRoster([spec("t", "surface", kind)]);
      run(s, 14);
      const j = s.jellies[0]!;
      const path: number[][] = [];
      run(s, 10, () => path.push([j.x, j.y]));
      const near = path.filter(([x, y]) => x > tile.x0 - j.length && x < tile.x1 + j.length && y < tile.y0 && y > tile.y0 - j.length * 3.2).length / path.length;
      assert.ok(near > 0.9, `${kind}, seed ${seed}: over its tile ${(near * 100).toFixed(0)}% of the time`);
      // Its tentacles hang above the tile, not over its text.
      const tips = j.strands.filter((x) => !x.arm).map((x) => x.nodes[x.nodes.length - 1]!);
      assert.ok(tips.every((y) => y < tile.y0 + j.length * 0.3), `${kind}, seed ${seed}: tentacles reach ${Math.max(...tips).toFixed(0)}, the tile is at ${tile.y0}`);
    }
  }
});

test("a jelly whose agent rests stays low; one at work roams the water", () => {
  for (const seed of [1, 2, 3, 4]) {
    const s = sea([spec("r", "rest")], [], seed);
    run(s, 25);
    const rest = s.jellies[0]!;
    let top = Infinity;
    run(s, 20, () => { top = Math.min(top, rest.y); });
    assert.ok(top > H * 0.8, `seed ${seed}: the resting jelly rose to ${top.toFixed(0)}`);
  }
  const s = sea([spec("h", "hunt")]);
  const hunt = s.jellies[0]!;
  const seen = new Set<string>();
  run(s, 60, () => seen.add(`${Math.floor(hunt.x / (W / 4))},${Math.floor(hunt.y / (H / 3))}`));
  assert.ok(seen.size >= 4, `the jelly at work went to ${seen.size} of 12 parts of the window`);
});

test("jellies keep out from under the tiles", () => {
  const boxes: Box[] = [{ x0: 100, y0: 100, x1: 600, y1: 450 }, { x0: 800, y0: 300, x1: 1300, y1: 700 }];
  for (const seed of [2, 3, 4]) {
    const s = sea(["a", "b", "c", "d"].map((k) => spec(k, "hunt", "pelagia")), boxes, seed);
    let under = 0;
    let all = 0;
    run(s, 60, () => {
      for (const j of s.jellies) {
        all++;
        // The middle of its bell.
        const y = j.y - j.shape.h * j.length * 0.5;
        if (boxes.some((b) => j.x > b.x0 && j.x < b.x1 && y > b.y0 && y < b.y1)) under++;
      }
    });
    assert.ok(under / all < 0.005, `seed ${seed}: under a tile ${((under / all) * 100).toFixed(2)}% of the time`);
  }
});

test("a closed agent's jelly swims off and is gone; a finished turn flashes and fades", () => {
  const s = sea([spec("a", "cruise"), spec("b", "cruise")]);
  run(s, 1);
  s.finished("a");
  assert.equal(s.jellies.find((j) => j.key === "a")!.glow, 1);
  run(s, 2);
  assert.equal(s.jellies.find((j) => j.key === "a")!.glow, 0);
  s.setRoster([spec("b", "cruise")]);
  run(s, 40);
  assert.deepEqual(s.jellies.map((j) => j.key), ["b"]);
});

test("the marine snow keeps falling, and as much of it stays in the water", () => {
  const s = sea([spec("a", "hunt")]);
  const n = s.snow.length;
  const before = s.snow.reduce((sum, m) => sum + m.y, 0) / n;
  run(s, 2);
  const after = s.snow.reduce((sum, m) => sum + m.y, 0) / n;
  assert.notEqual(after, before);
  run(s, 120);
  assert.equal(s.snow.length, n);
  assert.ok(s.snow.every((m) => m.y > -10 && m.y < H + 10), "a speck left the water");
  assert.ok(s.snow.filter((m) => m.y < H / 3).length > n * 0.2, "the snow piled up at the bottom");
});
