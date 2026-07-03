import { test } from "node:test";
import assert from "node:assert/strict";
import { clampAnchor } from "../../src/renderer/src/pin-anchor";

test("clampAnchor keeps a pinned panel inside the window", () => {
  const win = { w: 1200, h: 800 };
  const tile = { w: 400, h: 300 };
  // In-bounds → unchanged.
  assert.deepEqual(clampAnchor({ sx: 500, sy: 400 }, tile, win, 14), { sx: 500, sy: 400 });
  // Off the top-left → pulled to the margin.
  assert.deepEqual(clampAnchor({ sx: -50, sy: -80 }, tile, win, 14), { sx: 14, sy: 14 });
  // Off the bottom-right → pulled so the panel's far edge sits at window - margin.
  assert.deepEqual(clampAnchor({ sx: 2000, sy: 2000 }, tile, win, 14), { sx: 1200 - 400 - 14, sy: 800 - 300 - 14 });
});

test("clampAnchor: a panel larger than the window pins its top-left to the margin", () => {
  // Plan-review-style panel taller + wider than the window: top-left wins so the
  // header + unpin control stay on screen (bottom/right overflow is unavoidable).
  const clamped = clampAnchor({ sx: 0, sy: 0 }, { w: 1600, h: 1000 }, { w: 1000, h: 700 }, 14);
  assert.deepEqual(clamped, { sx: 14, sy: 14 });
});
