// The board's pure part (board-objects/board-model.ts): where a box is kept versus where it is
// drawn, what an arrow joins, and what a board edit takes with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import {
  duplicateBox, facingSides, newBox, sidePoint, toCanvas, toStored, withoutObject, type BoxObject,
} from "../../src/renderer/src/board-objects/board-model.ts";
import type { FrameState } from "../../src/renderer/src/canvas-persistence.ts";

const frame = (over: Partial<FrameState>): FrameState => ({ id: "f", x: 0, y: 0, w: 800, h: 600, title: "F", color: "#fff", z: 1, ...over });
const note = (over: Partial<BoxObject> = {}): BoardObject =>
  ({ id: "n1", kind: "note", x: 0, y: 0, w: 220, h: 180, color: "yellow", text: "", ...over }) as BoardObject;

test("a framed box is kept relative to its frame and drawn on the canvas, so moving the frame changes nothing kept", () => {
  const kept = [note({ frame: "f", x: 30, y: 40 }), note({ id: "loose", x: 5, y: 6 })];
  const drawn = toCanvas(kept, [frame({ x: 100, y: 50 })]);
  assert.deepEqual(drawn, [note({ frame: "f", x: 130, y: 90 }), note({ id: "loose", x: 5, y: 6 })]);

  // The frame moves by (+200, +10) and carries its box: what is kept stays as it was.
  const moved = drawn.map((o) => (o.kind === "note" && o.frame ? { ...o, x: o.x + 200, y: o.y + 10 } : o));
  assert.deepEqual(toStored(moved, [frame({ x: 300, y: 60 })]), kept);
});

test("a box whose frame is gone is kept loose, where it is drawn", () => {
  assert.deepEqual(toStored([note({ frame: "gone", x: 130, y: 90 })], [frame({})]), [note({ x: 130, y: 90 })]);
  assert.deepEqual(toCanvas([note({ frame: "gone", x: 30, y: 40 })], [frame({})]), [note({ frame: "gone", x: 30, y: 40 })]);
});

test("an arrow joins the sides two boxes face each other on, at the middle of each", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(facingSides(a, { x: 400, y: 20, w: 100, h: 50 }), ["right", "left"]);
  assert.deepEqual(facingSides(a, { x: -400, y: 20, w: 100, h: 50 }), ["left", "right"]);
  assert.deepEqual(facingSides(a, { x: 20, y: 300, w: 100, h: 50 }), ["bottom", "top"]);
  assert.deepEqual(facingSides(a, { x: 20, y: -300, w: 100, h: 50 }), ["top", "bottom"]);
  // Diagonal: the axis their middles are further apart on decides.
  assert.deepEqual(facingSides(a, { x: 300, y: 200, w: 100, h: 50 }), ["right", "left"]);
  assert.deepEqual(facingSides(a, { x: 200, y: 300, w: 100, h: 50 }), ["bottom", "top"]);
  assert.deepEqual(sidePoint(a, "right"), { x: 100, y: 25 });
  assert.deepEqual(sidePoint(a, "top"), { x: 50, y: 0 });
});

test("deleting a box takes the arrows that end on it, and no other", () => {
  const board: BoardObject[] = [
    note(),
    note({ id: "n2" }),
    { id: "a1", kind: "arrow", from: { id: "n1", side: "right" }, to: { id: "n2", side: "left" }, label: "" },
    { id: "a2", kind: "arrow", from: { id: "n2", side: "right" }, to: { id: "tile-1", side: "left" }, label: "" },
    { id: "a3", kind: "arrow", from: { id: "tile-1", side: "top" }, to: { id: "n1", side: "bottom" }, label: "" },
  ];
  assert.deepEqual(withoutObject(board, "n1").map((o) => o.id), ["n2", "a2"]);
});

test("a new box is centred where it is added and joins the frame there; a copy of one gets new ids", () => {
  const frames = [frame({ id: "outer", x: 0, y: 0, w: 1000, h: 1000, z: 1 }), frame({ id: "inner", x: 100, y: 100, w: 400, h: 400, parentFrameId: "outer", z: 2 })];
  const box = newBox("note", "n9", { x: 300, y: 300 }, frames, 4);
  assert.deepEqual({ x: box.x, y: box.y, frame: box.frame, z: box.z }, { x: 190, y: 210, frame: "inner", z: 4 });
  assert.equal(newBox("text", "t9", { x: 5000, y: 5000 }, frames, 1).frame, undefined);
  // Where two frames overlap, the one in front, wherever it is in the list.
  const overlapping = [frame({ id: "back", x: 0, y: 0, w: 800, h: 600, z: 1 }), frame({ id: "front", x: 500, y: 0, w: 800, h: 600, z: 3 })];
  assert.equal(newBox("note", "n8", { x: 600, y: 300 }, overlapping, 1).frame, "front");

  const list = { id: "c1", kind: "checklist", x: 0, y: 0, w: 260, h: 200, text: "t", items: [{ id: "i1", text: "a", done: true }] } as BoxObject;
  let n = 0;
  const copy = duplicateBox(list, "c2", 7, () => `item-${++n}`);
  assert.deepEqual(copy, { ...list, id: "c2", x: 24, y: 24, z: 7, items: [{ id: "item-1", text: "a", done: true }] });
});
