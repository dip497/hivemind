/**
 * Koi Pond (live/koi): each program's koi is known by its variety's pattern, which rides its skin;
 * a lily pad has its notch cut and its flower on it, the pads lie apart and drift back in from the
 * other side; and a koi whose agent needs you mouths at the surface, a ring every two seconds or so,
 * where nothing else does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KOI_KINDS, KOI_SHAPES } from "../../src/renderer/src/live/koi/shapes";
import { padCell, PadPart, Pond, RIPPLE_LIFE, type Pad, type Surfacer } from "../../src/renderer/src/live/koi/pond";

const L = 200;
/** The markings a koi of `kind` shows over its back and its fins: which, and where. */
function pattern(kind: (typeof KOI_KINDS)[number], id: number) {
  const shape = KOI_SHAPES[kind];
  const seen = new Map<number, number[]>();
  for (let s = 0.01; s < 0.8; s += 0.01) {
    for (let across = -0.95; across <= 0.95; across += 0.1) {
      const v = across * shape.halfWidth(s) * L;
      const m = shape.mark?.(s, v, L, Math.abs(across), id, false) ?? 0;
      seen.set(m, [...(seen.get(m) ?? []), s]);
    }
  }
  const fins = new Set([0.2, 0.5, 0.9].map((s) => shape.mark?.(s, 30, L, 0, id, true) ?? 0));
  return { marks: new Set(seen.keys()), along: seen, fins };
}

test("each variety is known by its pattern, and a koi's pattern is the same wherever it swims", () => {
  for (const id of [3, 17, 42]) {
    const kohaku = pattern("kohaku", id);
    assert.deepEqual([...kohaku.marks].sort(), [0, 1], "kohaku: white with red");
    assert.deepEqual([...kohaku.fins], [0], "kohaku: white fins");
    assert.deepEqual([...pattern("sanke", id).marks].sort(), [0, 1, 2], "sanke: white, red and black");
    const showa = pattern("showa", id);
    assert.deepEqual([...showa.marks].sort(), [0, 1, 2], "showa: black, red and white");
    // A tancho's one red spot is on its head.
    const tancho = pattern("tancho", id);
    assert.ok(tancho.along.get(1)!.every((s) => s < 0.15), "tancho: red on the head only");
    assert.deepEqual([...pattern("ogon", id).marks], [0], "ogon: one colour");
    assert.deepEqual([...pattern("platinum", id).marks], [0], "platinum: one colour");
    assert.ok(pattern("asagi", id).fins.has(1), "asagi: red fins");
    assert.deepEqual([...pattern("chagoi", id).marks].sort(), [0, 1], "chagoi: copper netted");
  }
  // Two kohaku differ, and one is the same each time.
  const a = pattern("kohaku", 3).along.get(1)!.join();
  assert.notEqual(pattern("kohaku", 4).along.get(1)!.join(), a);
  assert.equal(pattern("kohaku", 3).along.get(1)!.join(), a);
});

const pad = (over: Partial<Pad> = {}): Pad => ({ x: 0, y: 0, r: 60, turn: 0, notch: 0.3, spin: 0, vx: 0, vy: 0, flower: null, seed: 1, ...over });

test("a pad has its notch cut to near its middle, a rim, veins and, if it has one, its flower", () => {
  const p = pad();
  const cw = 8;
  // Along the notch (it points along `turn`, here to the right) there is nothing past its tip.
  for (let d = cw * 1.5; d < 60; d += 4) assert.equal(padCell(p, d, 0, cw), PadPart.None, `notch at ${d}`);
  // Turned, the notch turns with it.
  assert.notEqual(padCell(pad({ turn: Math.PI }), 40, 0, cw), PadPart.None);
  assert.equal(padCell(pad({ turn: Math.PI }), -40, 0, cw), PadPart.None);
  // The rim, and nothing past it.
  assert.equal(padCell(p, -57, 0, cw), PadPart.Rim);
  assert.equal(padCell(p, -61, 0, cw), PadPart.None);
  const inside = [];
  for (let a = 0.6; a < 5.6; a += 0.05) inside.push(padCell(p, Math.cos(a) * 30, Math.sin(a) * 30, cw));
  assert.ok(inside.includes(PadPart.Vein) && inside.includes(PadPart.Leaf), "veins on the leaf");
  // The flower, at its place on the pad.
  const f = pad({ flower: Math.PI / 2 });
  assert.equal(padCell(f, 0, 60 * 0.45, cw), PadPart.Heart);
  assert.equal(padCell(f, cw * 1.4, 60 * 0.45, cw), PadPart.Petal);
  assert.ok(![PadPart.Heart, PadPart.Petal].includes(padCell(p, 0, 60 * 0.45, cw) as 4 | 5), "no flower on a pad without one");
});

test("the pads lie apart, and one that drifts off a side comes back on the other", () => {
  const pond = new Pond();
  pond.build(1440, 900);
  assert.ok(pond.pads.length >= 8, `${pond.pads.length} pads`);
  for (const [i, a] of pond.pads.entries()) {
    for (const b of pond.pads.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r, "two pads overlap");
  }
  const p = pond.pads[0]!;
  p.vx = 50;
  p.vy = 0;
  p.x = 1440 + p.r - 1;
  pond.step(1);
  assert.ok(p.x < 0, `came back in on the left, at ${p.x}`);
});

const koi = (id: number, mood: Surfacer["mood"]): Surfacer => ({ id, mood, leaving: false, nodes: new Float32Array([100 * id, 50, 0, 0]) });

test("a koi whose agent needs you mouths at the surface, a ring every two seconds or so; the others make none", () => {
  const pond = new Pond();
  pond.build(1440, 900);
  const swimming = [koi(1, "surface"), koi(2, "hunt"), koi(3, "cruise"), koi(4, "rest")];
  const rings = new Map<number, number>();
  for (let t = 0.5; t < 20; t += 0.1) {
    pond.step(0.1);
    pond.surface(swimming, t);
    for (const r of pond.ripples) if (r.age === 0) rings.set(r.x, (rings.get(r.x) ?? 0) + 1);
    // A ring fades out and is gone.
    for (const r of pond.ripples) assert.ok(r.age <= RIPPLE_LIFE);
  }
  const mouthed = rings.get(100) ?? 0;
  assert.ok(mouthed >= 7 && mouthed <= 12, `the koi that needs you: ${mouthed} rings in 20 s`);
  for (const x of [200, 300, 400]) assert.equal(rings.get(x) ?? 0, 0, `the koi at ${x}`);
});
