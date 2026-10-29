/**
 * A live scene's drawing (live/cells, coveredCells): no creature is drawn under a tile or a panel,
 * nor in a seam between two tiles narrower than a cell, so a shark passing under a block of tiles
 * does not show through as a strip. A wider gap is open water, where it shows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coveredCells } from "../../src/renderer/src/live/cells";

const CW = 8;
const CH = 12;
const COLS = 100;
const ROWS = 60;
const at = (cover: Uint8Array, x: number, y: number) => cover[Math.floor(y / CH) * COLS + Math.floor(x / CW)];

test("the seam between two tiles narrower than a cell is covered, a wider gap is not", () => {
  const top = 120;
  const bottom = 300;
  const cover = coveredCells([
    { x0: 100, y0: top, x1: 300, y1: bottom },
    // 6px apart, as at a far zoom.
    { x0: 306, y0: top, x1: 500, y1: bottom },
    // 40px further on: water between them.
    { x0: 540, y0: top, x1: 700, y1: bottom },
  ], COLS, ROWS, CW, CH);
  for (let y = top; y < bottom; y += CH) {
    for (let x = 100; x < 500; x += 2) assert.equal(at(cover, x, y), 1, `(${x}, ${y}) under the first two`);
    assert.equal(at(cover, 520, y), 0, `(520, ${y}) between the second and third`);
  }
  // Clear of every tile.
  assert.equal(at(cover, 50, 50), 0);
  assert.equal(at(cover, 400, bottom + 2 * CH), 0);
});

test("a box past the window's edges covers what is in the window and nothing else", () => {
  const cover = coveredCells([{ x0: -50, y0: -50, x1: 60, y1: 60 }, { x0: COLS * CW - 40, y0: ROWS * CH - 30, x1: COLS * CW + 90, y1: ROWS * CH + 90 }], COLS, ROWS, CW, CH);
  assert.equal(cover.length, COLS * ROWS);
  assert.equal(at(cover, 0, 0), 1);
  assert.equal(at(cover, COLS * CW - 1, ROWS * CH - 1), 1);
  assert.equal(at(cover, 200, 200), 0);
});
