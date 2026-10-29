/**
 * Shoal's water (shoal/world): a shark whose agent needs you circles that agent's tile, the fish
 * and the roaming sharks keep to the open water between the tiles, a closed agent's shark swims
 * off, and a finished turn is a bite where the shark is. The simulation is random; each test runs
 * it on fixed seeds so a failure repeats, and each bar sits well clear of what 40 or more other
 * seeds measured (noted at each).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { World, type Box, type SwimmerSpec } from "../../src/renderer/src/live/world";

const W = 1440;
const H = 900;
const STEP = 1 / 60;

/** Math.random on a fixed seed (mulberry32) for the length of `run`. */
function seeded<T>(seed: number, run: () => T): T {
  const real = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return run(); } finally { Math.random = real; }
}

function water(sharks: SwimmerSpec[], boxes: Box[] = []): World {
  const w = new World();
  w.resize(W, H, 12, 17);
  w.setRoster(sharks);
  w.setBoxes(boxes);
  return w;
}
const run = (w: World, secs: number) => { for (let i = 0; i < secs / STEP; i++) w.step(STEP); };
const shark = (key: string, mood: SwimmerSpec["mood"]): SwimmerSpec => ({ key, kind: "classic", size: 1, mood });
const sharkOf = (w: World, key: string) => w.swimmers.find((s) => s.key === key)!;
/** How far a point is outside a box (0 inside it). */
const outside = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));

const tile: Box = { x0: 560, y0: 300, x1: 880, y1: 520, key: "a" };

test("a shark whose agent needs you circles that agent's tile, and comes up nearest", () => {
  for (const seed of [1, 2, 3]) seeded(seed, () => {
    const w = water([shark("a", "surface"), shark("b", "cruise")], [tile, { x0: 60, y0: 600, x1: 360, y1: 860, key: "b" }]);
    run(w, 30);
    let near = 0;
    let under = 0;
    let samples = 0;
    for (let i = 0; i < 40; i++) {
      run(w, 0.5);
      const a = sharkOf(w, "a");
      samples++;
      const off = outside(tile, a.nodes[0]!, a.nodes[1]!);
      if (off < a.length * 0.6) near++;
      if (off === 0) under++;
    }
    // Over 60 seeds it was near its tile every time, and its snout never under it.
    assert.ok(near / samples >= 0.95, `seed ${seed}: near its tile ${near} of ${samples} times`);
    assert.ok(under / samples <= 0.05, `seed ${seed}: under its tile ${under} of ${samples} times`);
    // Nearest of the two, so drawn last, over the other.
    assert.equal(w.swimmers.at(-1)!.key, "a");
    assert.ok(sharkOf(w, "a").depth > 0.95);
  });
});

test("a shark whose agent does not need you roams instead of circling that agent's tile", () => {
  const own: Box = { ...tile, key: "b" };
  let near = 0;
  for (const seed of [11, 12, 13, 14]) seeded(seed, () => {
    const w = water([shark("b", "cruise")], [own]);
    run(w, 30);
    for (let i = 0; i < 40; i++) {
      run(w, 0.5);
      const b = sharkOf(w, "b");
      if (outside(own, b.nodes[0]!, b.nodes[1]!) < b.length * 0.6) near++;
    }
  });
  // Circling, it would be near it every time; roaming, 36% to 64% of the time over 40 seeds.
  assert.ok(near / 160 < 0.8, `near its tile ${near} of 160 times`);
});

/** How far a shark's body turns from snout to tail, in radians: π is folded back on itself. */
function bend(s: { nodes: Float32Array | number[] }) {
  const nd = s.nodes;
  let net = 0;
  let prev = Math.atan2(nd[1]! - nd[3]!, nd[0]! - nd[2]!);
  for (let j = 1; j < nd.length / 2 - 1; j++) {
    const a = Math.atan2(nd[j * 2 + 1]! - nd[j * 2 + 3]!, nd[j * 2]! - nd[j * 2 + 2]!);
    net += Math.atan2(Math.sin(a - prev), Math.cos(a - prev));
    prev = a;
  }
  return Math.abs(net);
}

test("sharks in no hurry swim in long curves and never double back on themselves", () => {
  for (const seed of [41, 42, 43]) seeded(seed, () => {
    const w = new World();
    w.resize(973, 883, 8, 12);
    w.setRoster([shark("a", "cruise"), { ...shark("b", "cruise"), size: 0.84 }, { ...shark("c", "cruise"), size: 0.77 }]);
    run(w, 10);
    let most = 0;
    for (let i = 0; i < 120; i++) {
      run(w, 0.25);
      for (const s of w.swimmers) most = Math.max(most, bend(s));
    }
    // Over 40 seeds the most any of three got was 2 radians; folded into a U, it is 2.9.
    assert.ok(most < 2.4, `seed ${seed}: bent ${most.toFixed(2)} radians`);
  });
});

test("sharks in no hurry turn before the window's edge and stay in sight", () => {
  let inside = 0;
  let nodes = 0;
  for (const seed of [61, 62, 63, 64, 65, 66, 67, 68]) seeded(seed, () => {
    const w = new World({ fishCount: 0 });
    w.resize(973, 883, 8, 12);
    w.setRoster([shark("a", "cruise"), { ...shark("b", "cruise"), size: 0.9 }, { ...shark("c", "cruise"), size: 0.84 }]);
    run(w, 10);
    for (let i = 0; i < 120; i++) {
      run(w, 0.25);
      for (const s of w.swimmers) for (let j = 0; j < s.nodes.length; j += 2) {
        nodes++;
        if (s.nodes[j]! >= 0 && s.nodes[j]! <= 973 && s.nodes[j + 1]! >= 0 && s.nodes[j + 1]! <= 883) inside++;
      }
    }
  });
  // Over ten runs of eight seeds, 91% to 96% of their bodies were in the window; turning back only
  // once the snout is out, 85% to 91%.
  assert.ok(inside / nodes > 0.9, `${((inside / nodes) * 100).toFixed(1)}% in sight`);
});

test("a hunting shark does not go after a fish under a tile or at the window's edge", () => {
  seeded(72, () => {
    /** The shark's target with it at (x, 450) heading right and the one fish at `fish`. */
    const targetWith = (x: number, fish: { x: number; y: number }, boxes: Box[] = []) => {
      const w = new World({ fishCount: 1 });
      w.resize(W, H, 12, 17);
      w.setRoster([shark("a", "hunt")], true);
      w.setBoxes(boxes);
      const a = sharkOf(w, "a");
      const seg = a.length / (a.nodes.length / 2 - 1);
      for (let k = 0; k < a.nodes.length / 2; k++) { a.nodes[k * 2] = x - k * seg; a.nodes[k * 2 + 1] = 450; }
      a.heading = 0;
      a.hunger = 1;
      a.retargetAt = 0;
      Object.assign(w.fish[0]!, fish, { vx: 0, vy: 0 });
      w.step(STEP);
      return a.target;
    };
    assert.ok(targetWith(600, { x: 760, y: 450 }), "a fish in open water ahead");
    assert.equal(targetWith(600, { x: 760, y: 450 }, [{ x0: 700, y0: 380, x1: 900, y1: 520 }]), null, "the same fish under a tile");
    assert.equal(targetWith(1150, { x: W - 30, y: 450 }), null, "a fish at the window's edge");
  });
});

test("a roaming shark swims on to somewhere ahead of it, not back where it came from", () => {
  let ahead = 0;
  let picks = 0;
  for (const seed of [51, 52, 53, 54, 55, 56, 57, 58]) seeded(seed, () => {
    // No fish: a roaming shark swims past them, and the water is quicker without.
    const w = new World({ fishCount: 0 });
    w.resize(W, H, 12, 17);
    w.setRoster([shark("a", "cruise")]);
    const a = sharkOf(w, "a");
    let goal = a.goal;
    for (let i = 0; i < 60 / STEP; i++) {
      const heading = a.heading;
      w.step(STEP);
      if (a.goal === goal || !a.goal) continue;
      goal = a.goal;
      picks++;
      const to = Math.atan2(goal.y - a.nodes[1]!, goal.x - a.nodes[0]!);
      if (Math.cos(to - heading) > 0) ahead++;
    }
  });
  // Picked anywhere, 52% to 70% were ahead of it over 14 runs of eight seeds; picked ahead, 85% or more.
  assert.ok(picks >= 40, `${picks} goals picked`);
  assert.ok(ahead / picks > 0.78, `${ahead} of ${picks} goals ahead of it`);
});

test("fish keep out from under the tiles, and snouts turn away before them", () => {
  seeded(5, () => {
    const box: Box = { x0: 420, y0: 220, x1: 1020, y1: 680 };
    const w = water([shark("a", "hunt"), shark("b", "cruise")], [box]);
    run(w, 20);
    let snoutsUnder = 0;
    let fishUnder = 0;
    let fish = 0;
    for (let i = 0; i < 20; i++) {
      run(w, 0.5);
      for (const f of w.fish) {
        if (!f.alive) continue;
        fish++;
        if (outside(box, f.x, f.y) === 0 && f.x > box.x0 + 10 && f.x < box.x1 - 10 && f.y > box.y0 + 10 && f.y < box.y1 - 10) fishUnder++;
      }
      // Well under it: a hunting shark's snout may dip under a tile's edge after a fish there.
      for (const s of w.swimmers) if (outside({ x0: box.x0 + s.length * 0.15, y0: box.y0 + s.length * 0.15, x1: box.x1 - s.length * 0.15, y1: box.y1 - s.length * 0.15 }, s.nodes[0]!, s.nodes[1]!) === 0) snoutsUnder++;
    }
    // The box is a fifth of the window: left alone, a fifth of the fish would be under it, and the
    // snouts a third of the time. Over 40 seeds: at most 3.4% of the fish, and the snouts 11%.
    assert.ok(fishUnder / fish < 0.06, `${fishUnder} of ${fish} fish under the tile`);
    assert.ok(snoutsUnder / 40 < 0.2, `snouts under the tile ${snoutsUnder} of 40 times`);
  });
});

test("a shark a tile is put down over swims out from under it quickly", () => {
  for (const seed of [21, 22, 23, 24, 25, 26]) seeded(seed, () => {
    const w = water([shark("a", "cruise")]);
    run(w, 10);
    const a = sharkOf(w, "a");
    const box: Box = { x0: a.nodes[0]! - 150, y0: a.nodes[1]! - 150, x1: a.nodes[0]! + 150, y1: a.nodes[1]! + 150 };
    w.setBoxes([box]);
    let secs = 0;
    while (secs < 10 && outside(box, a.nodes[0]!, a.nodes[1]!) === 0) { run(w, 0.1); secs += 0.1; }
    // Over 40 seeds it was out within 2 s; at its cruising pace it would take 5 s or more.
    assert.ok(secs < 4, `seed ${seed}: out after ${secs.toFixed(1)} s`);
  });
});

test("a tile that fills most of the window is not kept out from under", () => {
  seeded(6, () => {
    const w = water([], [{ x0: 0, y0: 0, x1: W, y1: H * 0.8 }]);
    run(w, 10);
    // Well inside it: kept out, the fish would crowd its edges and the strip below it.
    const under = w.fish.filter((f) => f.alive && f.x > 100 && f.x < W - 100 && f.y > 60 && f.y < H * 0.7).length;
    assert.ok(under > w.fish.length * 0.4, `${under} of ${w.fish.length} fish under it`);
  });
});

test("a closed agent's shark swims off before it is dropped, and one that comes back stays", () => {
  seeded(7, () => {
    const w = water([shark("a", "cruise"), shark("b", "cruise")]);
    run(w, 5);
    w.setRoster([shark("b", "cruise")]);
    run(w, 0.5);
    assert.ok(sharkOf(w, "a").leaving, "it is still there, swimming off");
    run(w, 40);
    assert.deepEqual(w.swimmers.map((s) => s.key), ["b"]);
    w.setRoster([shark("b", "cruise"), shark("a", "hunt")]);
    w.setRoster([shark("b", "cruise")]);
    w.setRoster([shark("b", "cruise"), shark("a", "hunt")]);
    assert.equal(w.swimmers.filter((s) => s.key === "a" && !s.leaving).length, 1);
  });
});

test("a finished turn is a bite where the shark is, and the fish there scatter", () => {
  seeded(8, () => {
    const w = water([shark("a", "hunt")]);
    run(w, 5);
    const a = sharkOf(w, "a");
    w.events.length = 0;
    w.finished("a");
    assert.deepEqual(w.events, [{ kind: "bite", x: a.nodes[0], y: a.nodes[1] }]);
    assert.equal(a.hunger, 0);
    const nearby = w.fish.filter((f) => f.alive && Math.hypot(f.x - a.nodes[0]!, f.y - a.nodes[1]!) < 150);
    assert.ok(nearby.length > 0 && nearby.every((f) => f.alarm === 1));
    // An agent the scene has no shark for bites nothing.
    w.events.length = 0;
    w.finished("nobody");
    assert.deepEqual(w.events, []);
  });
});

test("a still picture changes only what changed: a closed agent's shark goes at once, a new one is in sight, one that needs you is by its tile", () => {
  seeded(31, () => {
    const w = water([shark("a", "cruise"), shark("b", "cruise")], [tile]);
    w.setRoster([shark("a", "cruise"), shark("b", "cruise")], true);
    run(w, 6);
    const b = sharkOf(w, "b");
    const bWas = [...b.nodes];
    w.setRoster([shark("b", "cruise"), shark("c", "hunt")], true);
    assert.deepEqual(w.swimmers.map((s) => s.key).sort(), ["b", "c"]);
    assert.deepEqual([...b.nodes], bWas, "the shark nothing happened to has not moved");
    const c = sharkOf(w, "c");
    assert.ok(c.nodes[0]! > 0 && c.nodes[0]! < W && c.nodes[1]! > 0 && c.nodes[1]! < H, "the new shark is in sight");
    assert.equal(c.depth, 0.85, "already as near as its mood has it");
    // b's agent comes to need you: its shark is put by its tile, at once.
    const bTile: Box = { ...tile, key: "b" };
    w.setBoxes([bTile]);
    w.setRoster([shark("b", "surface"), shark("c", "hunt")], true);
    assert.ok(outside(bTile, b.nodes[0]!, b.nodes[1]!) < b.length * 0.6, "the shark that needs you is by its tile");
    assert.equal(b.depth, 1, "and already come up");
  });
});
