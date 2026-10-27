// A view is told the band of widget cards in its own pixels: a view that does not reach the
// window's edge has only the part of the band over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bandOver } from "../../src/renderer/src/board-objects/widget-band";

test("the band over a view is measured from the view's own edge, and never past the view", () => {
  const window = 1440;
  // A view filling the window has the whole band.
  assert.deepEqual(bandOver({ edge: "right", width: 268 }, { left: 0, right: 1440 }, window), { edge: "right", width: 268 });
  // One that stops 100px short of the right edge has what reaches past that; on the left, past its left side.
  assert.deepEqual(bandOver({ edge: "right", width: 268 }, { left: 0, right: 1340 }, window), { edge: "right", width: 168 });
  assert.deepEqual(bandOver({ edge: "left", width: 268 }, { left: 300, right: 1440 }, window), { edge: "left", width: 0 });
  assert.deepEqual(bandOver({ edge: "left", width: 520 }, { left: 300, right: 1440 }, window), { edge: "left", width: 220 });
  // A narrow view under two columns is covered, not more than covered.
  assert.deepEqual(bandOver({ edge: "right", width: 520 }, { left: 1040, right: 1440 }, window), { edge: "right", width: 400 });
});
