import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeBandClip } from "../../src/renderer/src/workspace/views/community/edge-band";

const box = { w: 1000, h: 600 };
test("a surface band flush against one edge clips the iframe with a rect inset", () => {
  assert.equal(edgeBandClip([{ tileId: "a", x: 500, y: 0, w: 500, h: 600 }], box), "inset(0 500px 0 0)");
  assert.equal(edgeBandClip([{ tileId: "a", x: 0, y: 0, w: 300, h: 600 }], box), "inset(0 0 0 300px)");
  assert.equal(edgeBandClip([{ tileId: "a", x: 0, y: 400, w: 1000, h: 200 }], box), "inset(0 0 200px 0)");
  assert.equal(edgeBandClip([{ tileId: "a", x: 0, y: 0, w: 1000, h: 150 }], box), "inset(150px 0 0 0)");
  // two stacked surfaces forming one right band
  assert.equal(edgeBandClip([{ tileId: "a", x: 600, y: 0, w: 400, h: 300 }, { tileId: "b", x: 600, y: 300, w: 400, h: 300 }], box), "inset(0 400px 0 0)");
  // within a pixel of the edges still counts (rounding)
  assert.equal(edgeBandClip([{ tileId: "a", x: 500, y: 1, w: 499, h: 598 }], box), "inset(0 500px 0 0)");
});
test("floating or partial surfaces are overlays: no clip", () => {
  assert.equal(edgeBandClip([], box), null);
  assert.equal(edgeBandClip([{ tileId: "a", x: 100, y: 100, w: 300, h: 200 }], box), null);
  assert.equal(edgeBandClip([{ tileId: "a", x: 500, y: 0, w: 500, h: 300 }], box), null); // right, but half height
  assert.equal(edgeBandClip([{ tileId: "a", x: 0, y: 0, w: 1000, h: 600 }], box), null); // covers everything: nothing to clip to
  assert.equal(edgeBandClip([{ tileId: "a", x: 500, y: 0, w: 500, h: 600 }], { w: 0, h: 0 }), null);
});
