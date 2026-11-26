// The overview (overview-model.ts): a card per top-level frame and per page, inner pages grouped
// under the page holding them, counts and agents' marks at any depth, and the filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import { CANVAS_CARD, filterOverview, overviewOf, type OverviewFrame, type OverviewTile } from "../../src/renderer/src/overview-model.ts";

const frame = (id: string, over: Partial<OverviewFrame> = {}): OverviewFrame => ({ id, title: id, x: 0, y: 0, w: 100, h: 100, ...over });
const agent = (id: string, over: Partial<OverviewTile> = {}): OverviewTile => ({ id, kind: "claude", name: id, box: { x: 0, y: 0, w: 10, h: 10 }, ...over });
const shape = (id: string, over: Record<string, unknown> = {}): BoardObject => ({ id, kind: "shape", form: "rect", x: 0, y: 0, w: 10, h: 10, ...over }) as BoardObject;

const shapeOf = (groups: ReturnType<typeof overviewOf>) => groups.map((g) => [g.path.join(" › "), g.cards.map((c) => c.id)]);

test("top-level frames and pages are cards; a page's inner pages are a group under it, a plain inner frame folds in", () => {
  const groups = overviewOf({
    frames: [
      frame("pay", { page: true, y: 500 }), frame("checkout", { page: true, parentFrameId: "pay" }),
      frame("notes", { parentFrameId: "checkout" }), frame("deep", { page: true, parentFrameId: "notes" }),
      frame("docs", { y: 10 }),
    ],
    tiles: [agent("loose")], frameOf: {}, objects: [],
  });
  assert.deepEqual(shapeOf(groups), [["", ["docs", "pay", CANVAS_CARD]], ["pay", ["checkout"]], ["pay › checkout", ["deep"]]]);
});

test("counts and marks hold everything inside, at any depth, and roll up to the pages holding it", () => {
  const [world, inner] = overviewOf({
    frames: [frame("pay", { page: true }), frame("checkout", { page: true, parentFrameId: "pay" })],
    tiles: [
      agent("a1", { attention: "working" }), agent("a2", { attention: "needs-you" }), agent("a3", { attention: "quiet" }),
      agent("a4", { attention: "done" }), { id: "t1", kind: "shell", name: "shell", box: null },
    ],
    frameOf: { a1: "pay", a2: "checkout", a3: "checkout", a4: "checkout", t1: "checkout" },
    objects: [shape("s1", { frame: "checkout", drawing: "d1" }), shape("s2", { frame: "checkout", drawing: "d1" }), shape("s3", { frame: "checkout" })],
  });
  const pay = world!.cards[0]!, checkout = inner!.cards[0]!;
  assert.deepEqual([checkout.agents, checkout.tiles, checkout.drawings], [3, 1, 2]);
  assert.deepEqual([pay.agents, pay.tiles, pay.drawings], [4, 1, 2]);
  assert.deepEqual(pay.attention, [{ attention: "needs-you", count: 1 }, { attention: "done", count: 1 }, { attention: "working", count: 1 }]);
  assert.deepEqual(checkout.attention, [{ attention: "needs-you", count: 1 }, { attention: "done", count: 1 }]);
});

test("things in no frame make one Canvas card, shown only when there are any", () => {
  assert.deepEqual(shapeOf(overviewOf({ frames: [frame("f")], tiles: [], frameOf: {}, objects: [] })), [["", ["f"]]]);
  const [world] = overviewOf({ frames: [frame("f")], tiles: [], frameOf: {}, objects: [shape("s", { x: 40, y: 50, text: "Loose idea" })] });
  const canvas = world!.cards.find((c) => c.id === CANVAS_CARD)!;
  assert.deepEqual([canvas.title, canvas.drawings, canvas.box], ["Canvas", 1, { x: 40, y: 50, w: 10, h: 10 }]);
});

test("the filter finds a card by its title or by the text inside it, every word, any case", () => {
  const groups = overviewOf({
    frames: [frame("pay", { title: "Payments" }), frame("docs", { title: "Docs" })],
    tiles: [agent("a1", { name: "Stripe agent" })], frameOf: { a1: "pay" },
    objects: [shape("s1", { frame: "docs", text: "Release Notes" })],
  });
  const ids = (q: string) => filterOverview(groups, q).flatMap((g) => g.cards.map((c) => c.id));
  assert.deepEqual(ids("payments"), ["pay"]);
  assert.deepEqual(ids("STRIPE"), ["pay"]);
  assert.deepEqual(ids("release notes"), ["docs"]);
  assert.deepEqual(ids("release stripe"), []);
  assert.deepEqual(ids("  "), ["pay", "docs"]);
});

test("built for 50 frames and 5000 objects in a few milliseconds", () => {
  const frames = Array.from({ length: 50 }, (_, i) => frame(`f${i}`, { page: i % 5 === 0 ? true : undefined, parentFrameId: i % 5 === 0 ? undefined : `f${i - (i % 5)}`, x: i * 200 }));
  const tiles = Array.from({ length: 50 }, (_, i) => agent(`a${i}`, { attention: "working" }));
  const frameOf = Object.fromEntries(tiles.map((t, i) => [t.id, `f${i}`]));
  const objects = Array.from({ length: 5000 }, (_, i) => shape(`s${i}`, { frame: `f${i % 50}`, drawing: `d${i % 300}`, text: i % 3 ? undefined : `label ${i}` }));
  let best = Infinity;
  for (let run = 0; run < 7; run++) {
    const t0 = performance.now();
    overviewOf({ frames, tiles, frameOf, objects });
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`overview model, 50 frames / 50 agents / 5000 objects: ${best.toFixed(2)} ms (best of 7)`);
  assert.ok(best < 50, `${best} ms`);
});
