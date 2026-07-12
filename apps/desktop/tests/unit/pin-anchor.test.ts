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

test("clampAnchor: shrinking the window pulls a stranded pin back into view", () => {
  // The regression this guards: a pin placed near the right/bottom edge of a big
  // window, then the window shrinks (unmaximise, monitor unplug, resize). Nothing
  // re-clamped on window resize, so the anchor stayed at its old screen pixel and
  // the panel sat entirely outside the viewport — permanently, since the anchor is
  // persisted. Canvas re-runs clampAnchor on every `resize`; this asserts the math
  // that rescue depends on.
  const tile = { w: 400, h: 300 };
  // Comfortably inside a 1920×1200 window: right edge 1900 ≤ 1906, bottom 1100 ≤ 1186.
  const anchor = { sx: 1500, sy: 800 };
  assert.deepEqual(clampAnchor(anchor, tile, { w: 1920, h: 1200 }, 14), anchor);
  // …stranded once the window is 1000×700, so it must be pulled fully inside.
  const rescued = clampAnchor(anchor, tile, { w: 1000, h: 700 }, 14);
  assert.deepEqual(rescued, { sx: 1000 - 400 - 14, sy: 700 - 300 - 14 });
  assert.ok(rescued.sx + tile.w <= 1000, "right edge inside the window");
  assert.ok(rescued.sy + tile.h <= 700, "bottom edge inside the window");
});
