import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_FONT,
  MAX_FONT,
  clampFont,
  computeOptimalFont,
} from "../../src/renderer/src/tile-font-calc";

test("clampFont rounds and bounds to the px range", () => {
  assert.equal(clampFont(15.4), 15);
  assert.equal(clampFont(15.6), 16);
  assert.equal(clampFont(MIN_FONT - 3), MIN_FONT);
  assert.equal(clampFont(MAX_FONT + 50), MAX_FONT);
  assert.equal(clampFont(NaN), MIN_FONT);
});

test("computeOptimalFont grows the font with screen height (more cols/rows, no zoom)", () => {
  const f1080 = computeOptimalFont(1080, 1);
  const f1440 = computeOptimalFont(1440, 1);
  assert.ok(f1440 > f1080, "taller display → larger font");
  assert.ok(Number.isInteger(f1080) && Number.isInteger(f1440), "integer px");
  assert.ok(f1080 >= MIN_FONT && f1440 <= MAX_FONT, "within bounds");
});

test("computeOptimalFont biases UP on low-DPR displays (the only crispness lever)", () => {
  // Same logical height; DPR=1 (crisp only at 100% zoom) gets a larger cell than
  // an already-crisp HiDPI panel.
  const low = computeOptimalFont(1440, 1);
  const high = computeOptimalFont(1440, 2);
  assert.ok(low >= high, "low-DPR font is biased up vs HiDPI");
});

test("computeOptimalFont tolerates bad inputs", () => {
  assert.equal(computeOptimalFont(0, 0), computeOptimalFont(1080, 1));
  assert.equal(computeOptimalFont(NaN, NaN), computeOptimalFont(1080, 1));
});
