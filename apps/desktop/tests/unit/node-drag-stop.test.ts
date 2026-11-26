// A drag that carried several nodes saves every one of them by its type (useNodeDragStop.ts):
// tiles and shapes let go together must not jump back.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node } from "@xyflow/react";
import { dropNodes, type NodeDragStopCtx } from "../../src/renderer/src/useNodeDragStop.ts";

function recorder() {
  const tiles: Array<[string, number, number]> = [];
  const boxes: Array<Array<[string, { x: number; y: number }]>> = [];
  const ctx: NodeDragStopCtx = {
    framesRef: { current: [{ id: "f1", x: 1000, y: 1000, w: 400, h: 300 } as never] },
    frameOfRef: { current: {} },
    sizesRef: { current: {} },
    tilesRef: { current: [{ id: "t1", kind: "shell" } as never] },
    lastActiveFrameRef: { current: null },
    setPositions: () => {}, setFrames: () => {}, setFrameOf: () => {},
    parentFrameOf: () => null,
    moveFrame: () => {},
    commitPosition: (id, x, y) => { tiles.push([id, x, y]); },
    clearDragging: () => {},
    moveBoxes: (places) => { boxes.push([...places]); },
    shiftBoxes: () => {},
  };
  return { ctx, tiles, boxes };
}
const tile: Node = { id: "t1", type: "terminal", position: { x: 10, y: 20 }, data: {} };
const shape: Node = { id: "s1", type: "shape", position: { x: 30, y: 40 }, data: {} };
const inFrame: Node = { id: "s2", type: "shape", position: { x: 5, y: 6 }, parentId: "f1", data: {} };

test("a tile and shapes dragged together are each saved where they were let go, whichever was held", () => {
  for (const held of [shape, tile]) {
    const { ctx, tiles, boxes } = recorder();
    dropNodes(ctx, held, [shape, tile, inFrame]);
    assert.deepEqual(tiles, [["t1", 10, 20]], `held ${held.id}: the tile`);
    assert.deepEqual(boxes, [[["s1", { x: 30, y: 40 }], ["s2", { x: 1005, y: 1006 }]]], `held ${held.id}: the shapes, in one edit, a framed one on the canvas`);
  }
});

test("one node dragged alone is saved", () => {
  const { ctx, tiles, boxes } = recorder();
  dropNodes(ctx, shape);
  assert.deepEqual(tiles, []);
  assert.deepEqual(boxes, [[["s1", { x: 30, y: 40 }]]]);
});
