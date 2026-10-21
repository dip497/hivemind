// Widget cards nobody has moved stack down an edge of the screen by their drawn size, so a tall one
// is never covered by the cards placed under it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stackDownEdge, type Size, type Spot } from "../../src/renderer/src/board-objects/widget-stack";

const overlaps = (a: Spot & Size, b: Spot & Size) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function assertNoneOverlap(sizes: Record<string, Size>, spots: Record<string, Spot>, screen: Size) {
  const cards = Object.keys(sizes).map((id) => ({ id, ...sizes[id], ...spots[id] }));
  for (const card of cards) {
    assert.ok(card.x >= 0 && card.x + card.w <= screen.w, `${card.id} runs off the side`);
    assert.ok(card.y >= 0 && card.y + card.h <= screen.h, `${card.id} runs off the bottom`);
  }
  for (const [i, a] of cards.entries()) {
    for (const b of cards.slice(i + 1)) assert.ok(!overlaps(a, b), `${b.id} covers ${a.id}`);
  }
}

test("a tall widget is not covered by the widgets stacked under it", () => {
  const screen = { w: 1600, h: 1000 };
  const sizes = {
    "agent-pulse": { w: 240, h: 97 },
    "waiting-on-you": { w: 240, h: 131 },
    "issue-burndown": { w: 240, h: 343 },
    "launchpad": { w: 240, h: 158 },
    "ci-light": { w: 240, h: 79 },
  };
  const spots = stackDownEdge(Object.keys(sizes), sizes, screen);
  assertNoneOverlap(sizes, spots, screen);
  assert.equal(spots["agent-pulse"].x, spots["ci-light"].x, "they share the right-edge column");
});

test("cards too tall for one column go on in a column to the left", () => {
  const screen = { w: 1200, h: 700 };
  const sizes = { a: { w: 240, h: 400 }, b: { w: 240, h: 300 }, c: { w: 320, h: 200 }, d: { w: 240, h: 500 } };
  const spots = stackDownEdge(Object.keys(sizes), sizes, screen);
  assertNoneOverlap(sizes, spots, screen);
});

test("over a view that keeps the right for itself, cards stack down the left edge and run on to the right", () => {
  const screen = { w: 1600, h: 1000 };
  const sizes = { harbour: { w: 240, h: 300 }, ledger: { w: 240, h: 330 }, weather: { w: 240, h: 120 }, log: { w: 240, h: 260 } };
  const spots = stackDownEdge(Object.keys(sizes), sizes, screen, "left");
  assertNoneOverlap(sizes, spots, screen);
  assert.deepEqual([spots.harbour, spots.ledger, spots.weather], [{ x: 16, y: 64 }, { x: 16, y: 376 }, { x: 16, y: 718 }]);
  // The log does not fit under the weather: a second column, beside the first and not off the left.
  assert.deepEqual(spots.log, { x: 268, y: 64 });
});
