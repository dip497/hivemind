import { test } from "node:test";
import assert from "node:assert/strict";
import { fitScale, nextZoom, sharpPixels, sizeText } from "../../src/renderer/src/image-zoom";

test("zoom moves by fixed steps, from a fit between steps too, and stops at the ends", () => {
  assert.equal(nextZoom(1, 1), 1.5);
  assert.equal(nextZoom(1, -1), 0.75);
  assert.equal(nextZoom(0.6, 1), 0.75);
  assert.equal(nextZoom(0.6, -1), 0.5);
  assert.equal(nextZoom(16, 1), 16);
  assert.equal(nextZoom(0.1, -1), 0.1);
});

test("a picture fits its tile, and a small one shows at its own size", () => {
  assert.equal(fitScale(2000, 1000, 500, 500), 0.25);
  assert.equal(fitScale(16, 16, 500, 500), 1);
});

test("pixels are drawn square only above 3x", () => {
  assert.deepEqual([3, 4].map(sharpPixels), [false, true]);
});

test("the size line says bytes, KB and MB", () => {
  assert.deepEqual([12, 2048, 3 * 1024 * 1024 + 200 * 1024].map(sizeText), ["12 B", "2 KB", "3.2 MB"]);
});
