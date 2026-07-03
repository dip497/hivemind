import { test } from "node:test";
import assert from "node:assert/strict";
import { flowToPane, paneToFlow, clampAnchor, type Viewport } from "../../src/renderer/src/pin-anchor";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("paneToFlow inverts flowToPane (round-trip identity) across viewports", () => {
  const viewports: Viewport[] = [
    { x: 0, y: 0, zoom: 1 },
    { x: 120, y: -80, zoom: 1 },
    { x: -333.5, y: 210.25, zoom: 0.5 },
    { x: 42, y: 42, zoom: 2.5 },
  ];
  const positions = [
    { x: 0, y: 0 },
    { x: 700, y: 480 },
    { x: -250.75, y: 1000.5 },
  ];
  for (const vp of viewports) {
    for (const pos of positions) {
      const back = paneToFlow(flowToPane(pos, vp), vp);
      assert.ok(close(back.x, pos.x) && close(back.y, pos.y), `round-trip failed for ${JSON.stringify({ vp, pos })}`);
    }
  }
});

test("a pinned anchor holds the same pane pixel as the viewport pans", () => {
  // Pin captured at this viewport → this pane pixel.
  const vp0: Viewport = { x: 100, y: 50, zoom: 1 };
  const flow0 = { x: 300, y: 200 };
  const anchor = flowToPane(flow0, vp0); // { sx: 400, sy: 250 }
  assert.deepEqual(anchor, { sx: 400, sy: 250 });

  // Pan the canvas (viewport translate changes). The tile's flow position must
  // shift by the OPPOSITE of the pan so its pane pixel is unchanged.
  const vp1: Viewport = { x: 100 - 60, y: 50 + 25, zoom: 1 };
  const flow1 = paneToFlow(anchor, vp1);
  const paneAfter = flowToPane(flow1, vp1);
  assert.deepEqual(paneAfter, anchor);
  // Sanity: flow position actually moved (it's not a no-op).
  assert.notDeepEqual(flow1, flow0);
});

test("clampAnchor keeps a pinned tile inside the pane", () => {
  const pane = { w: 1200, h: 800 };
  const tile = { w: 400, h: 300 };
  // In-bounds → unchanged.
  assert.deepEqual(clampAnchor({ sx: 500, sy: 400 }, tile, pane, 14), { sx: 500, sy: 400 });
  // Off the top-left → pulled to the margin.
  assert.deepEqual(clampAnchor({ sx: -50, sy: -80 }, tile, pane, 14), { sx: 14, sy: 14 });
  // Off the bottom-right → pulled so the tile's far edge sits at pane - margin.
  assert.deepEqual(clampAnchor({ sx: 2000, sy: 2000 }, tile, pane, 14), { sx: 1200 - 400 - 14, sy: 800 - 300 - 14 });
});

test("clampAnchor: a tile larger than the pane pins its top-left to the margin", () => {
  // Plan-review-style tile taller + wider than the window: top-left wins so the
  // header + pin control stay on screen (bottom/right overflow is unavoidable).
  const clamped = clampAnchor({ sx: 0, sy: 0 }, { w: 1600, h: 1000 }, { w: 1000, h: 700 }, 14);
  assert.deepEqual(clamped, { sx: 14, sy: 14 });
});

test("zoom scales the flow offset but keeps the pane pixel fixed", () => {
  const anchor = { sx: 640, sy: 360 };
  const vp: Viewport = { x: 40, y: 20, zoom: 2 };
  const flow = paneToFlow(anchor, vp);
  assert.deepEqual(flow, { x: (640 - 40) / 2, y: (360 - 20) / 2 });
  assert.deepEqual(flowToPane(flow, vp), anchor);
});
