/**
 * Shoal's sea bed in colour (live/shoal/seabed): the reef keeps to the bottom of the window, below
 * where the tiles mostly are, on any shape of window, and a window shows the same reef each time it
 * is that size.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Seabed } from "../../src/renderer/src/live/shoal/seabed";

const SIZES: [number, number][] = [[180, 75], [110, 62], [320, 70], [90, 110], [60, 40]];

test("the reef keeps to the bottom fifth of the window, its weed swaying no higher than a quarter", () => {
  for (const [cols, rows] of SIZES) {
    const bed = new Seabed();
    bed.build(cols, rows);
    assert.ok(bed.cells.length > cols, `${cols}×${rows}: a reef, not a few cells`);
    const top = Math.min(...bed.cells.map((c) => c.r));
    assert.ok(top >= rows - Math.max(8, Math.round(rows * 0.2)), `${cols}×${rows}: the reef rises to row ${top}`);
    for (const c of bed.cells) assert.ok(c.c >= 0 && c.c < cols && c.r < rows, `${cols}×${rows}: a cell at ${c.c},${c.r}`);
    // Every column has its sand.
    const floor = new Set(bed.cells.filter((c) => c.r === rows - 1).map((c) => c.c));
    assert.equal(floor.size, cols, `${cols}×${rows}: the floor`);
    for (const w of bed.weeds) assert.ok(w.foot - w.height + 1 >= rows - Math.max(10, Math.round(rows * 0.26)), `${cols}×${rows}: a strand ${w.height} tall from row ${w.foot}`);
  }
});

test("the same window shows the same reef", () => {
  const a = new Seabed();
  const b = new Seabed();
  a.build(180, 75);
  b.build(180, 75);
  assert.deepEqual(b.cells, a.cells);
  assert.deepEqual(b.weeds, a.weeds);
});
