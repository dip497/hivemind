import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import { boundsOf, type CanvasState } from "../../src/renderer/src/fly-to";

const shape = (id: string, x: number, y: number, w: number, h: number, drawing?: string): BoardObject =>
  ({ id, kind: "shape", form: "rect", x, y, w, h, ...(drawing ? { drawing } : {}) });

const STATE: CanvasState = {
  frames: [{ id: "pay", x: 100, y: 100, w: 800, h: 600 }],
  positions: { term: { x: 2000, y: 0 }, closed: { x: -9000, y: -9000 } },
  sizeOf: (id) => (id === "term" ? { width: 640, height: 400 } : undefined),
  objects: [
    shape("a", 0, 0, 100, 50, "flow"),
    shape("b", 300, 500, 100, 50, "flow"),
    shape("loose", 5000, 5000, 10, 10),
    { id: "arrow", kind: "arrow", label: "", from: { id: "a", side: "right" }, to: { id: "term", side: "left" } },
  ],
};

test("a frame's box is the frame; a tile's is where it is at its size, and says it is a tile", () => {
  assert.deepEqual(boundsOf(STATE, "pay"), { box: { x: 100, y: 100, w: 800, h: 600 }, tile: false });
  assert.deepEqual(boundsOf(STATE, "term"), { box: { x: 2000, y: 0, w: 640, h: 400 }, tile: true });
});

test("a drawing's box takes in every shape of it, and an arrow's both its ends", () => {
  assert.deepEqual(boundsOf(STATE, "flow"), { box: { x: 0, y: 0, w: 400, h: 550 }, tile: false });
  assert.deepEqual(boundsOf(STATE, "arrow"), { box: { x: 0, y: 0, w: 2640, h: 400 }, tile: false });
  assert.deepEqual(boundsOf(STATE, ["a", "pay"])?.box, { x: 0, y: 0, w: 900, h: 700 });
});

test("everything is every frame, placed tile and box; a tile no longer there and an unknown id are nowhere", () => {
  assert.deepEqual(boundsOf(STATE, null)?.box, { x: 0, y: 0, w: 5010, h: 5010 });
  assert.equal(boundsOf(STATE, "closed"), null);
  assert.equal(boundsOf(STATE, "nothing"), null);
  assert.deepEqual(boundsOf(STATE, { x: 1, y: 2, w: 3, h: 4 }), { box: { x: 1, y: 2, w: 3, h: 4 }, tile: false });
});
