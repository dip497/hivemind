import { test } from "node:test";
import assert from "node:assert/strict";
import { focusZoom } from "../../src/renderer/src/camera-fit";

test("a frame that fits is shown at 100%, never enlarged past it", () => {
  assert.equal(focusZoom(840, 580, 1600, 1000), 1);
  assert.equal(focusZoom(100, 100, 1600, 1000), 1);
});

test("a rect too big for the pane is fitted, padding included, on its tighter axis", () => {
  // Usable pane is pane / 1.18; 2000 wide → (1600 / 1.18) / 2000.
  assert.ok(Math.abs(focusZoom(2000, 400, 1600, 1000) - 1600 / 1.18 / 2000) < 1e-9);
  assert.ok(Math.abs(focusZoom(400, 2000, 1600, 1000) - 1000 / 1.18 / 2000) < 1e-9);
});

// The regression: the target must be a function of the rect and the pane only, so
// the same request lands at the same zoom whatever the camera was doing before.
test("the answer does not depend on where the camera is", () => {
  const once = focusZoom(1256, 884, 1600, 1000);
  for (let i = 0; i < 5; i++) assert.equal(focusZoom(1256, 884, 1600, 1000), once);
});

test("an unmeasured pane or an unknown size falls back to 100%, not to zero", () => {
  assert.equal(focusZoom(840, 580, 0, 0), 1);
  assert.equal(focusZoom(0, 0, 1600, 1000), 1);
});
