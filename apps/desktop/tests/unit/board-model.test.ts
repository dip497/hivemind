// The board's pure part (board-objects/board-model.ts): where a box is kept versus where it is
// drawn, what an arrow joins, and what a board edit takes with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import type { Node } from "@xyflow/react";
import {
  facingSides, groupOf, pickTool, selectionOn, SHOWN_SELECTED_MOST, withSelected, showDrawing, isBox, isBoxType, keepUnchanged, newWidget, sidePoint, toCanvas, toStored, type BoxObject, widgetsOf, widgetsToBring, withChanges, withoutObject,
} from "../../src/renderer/src/board-objects/board-model.ts";
import type { FrameState } from "../../src/renderer/src/canvas-persistence.ts";

const frame = (over: Partial<FrameState>): FrameState => ({ id: "f", x: 0, y: 0, w: 800, h: 600, title: "F", color: "#fff", z: 1, ...over });
/** A sticky note: the app's `note` widget on the board. */
const note = (over: Partial<BoxObject> = {}): BoardObject =>
  ({ id: "n1", kind: "widget", widget: "note", placement: "board", x: 0, y: 0, w: 220, h: 180, text: "", ...over }) as BoardObject;

test("a framed box is kept relative to its frame and drawn on the canvas, so moving the frame changes nothing kept", () => {
  const kept = [note({ frame: "f", x: 30, y: 40 }), note({ id: "loose", x: 5, y: 6 })];
  const drawn = toCanvas(kept, [frame({ x: 100, y: 50 })]);
  assert.deepEqual(drawn, [note({ frame: "f", x: 130, y: 90 }), note({ id: "loose", x: 5, y: 6 })]);

  // The frame moves by (+200, +10) and carries its box: what is kept stays as it was.
  const moved = drawn.map((o) => (o.kind === "widget" && o.frame ? { ...o, x: o.x! + 200, y: o.y! + 10 } : o));
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

test("a new board widget is centred where it is added and joins the frame there; one added elsewhere floats", () => {
  const frames = [frame({ id: "outer", x: 0, y: 0, w: 1000, h: 1000, z: 1 }), frame({ id: "inner", x: 100, y: 100, w: 400, h: 400, parentFrameId: "outer", z: 2 })];
  const size = { w: 220, h: 180 };
  const box = newWidget("note", "n9", 4, { at: { x: 300, y: 300 }, size, frames });
  assert.deepEqual({ x: box.x, y: box.y, frame: box.frame, z: box.z, placement: box.placement, text: box.text }, { x: 190, y: 210, frame: "inner", z: 4, placement: "board", text: "" });
  assert.equal(newWidget("text", "t9", 1, { at: { x: 5000, y: 5000 }, size, frames }).frame, undefined);
  // Where two frames overlap, the one in front, wherever it is in the list.
  const overlapping = [frame({ id: "back", x: 0, y: 0, w: 800, h: 600, z: 1 }), frame({ id: "front", x: 500, y: 0, w: 800, h: 600, z: 3 })];
  assert.equal(newWidget("note", "n8", 1, { at: { x: 600, y: 300 }, size, frames: overlapping }).frame, "front");
  // A list's lines exist from the start; a widget added without a place floats, and is no box.
  assert.deepEqual(newWidget("checklist", "c9", 1, { at: { x: 0, y: 0 }, size, lines: true, frames }).items, []);
  const floating = newWidget("clock", "w1", 1);
  assert.deepEqual(widgetsOf([floating, box], "canvas").map((w) => w.id), ["w1"]);
});

test("a package's view brings each of its widgets to a workspace once: never a second copy, never one closed", () => {
  const members = ["@ada/harbour", "@ada/ledger", "@ada/weather"];
  // The first time: all of them, in the package's order.
  assert.deepEqual(widgetsToBring(members, ["note"], []), { add: members, brought: members });
  // Again, with the harbour closed since: nothing comes back.
  assert.deepEqual(widgetsToBring(members, ["@ada/ledger", "@ada/weather"], members), { add: [], brought: [] });
  // A later version of the package with a fourth widget: that one comes, the others are not copied.
  assert.deepEqual(widgetsToBring([...members, "@ada/log"], ["@ada/ledger"], members), { add: ["@ada/log"], brought: ["@ada/log"] });
  // One the person already added by hand is counted, not copied.
  assert.deepEqual(widgetsToBring([...members, "@ada/log"], ["@ada/log"], members), { add: [], brought: ["@ada/log"] });
  // A workspace where the person put some of them by hand, before any view brought one: as arranged.
  assert.deepEqual(widgetsToBring(members, ["@ada/ledger"], []), { add: [], brought: members });
});

const drawnShape = (id: string, more: Record<string, unknown> = {}) => ({ id, kind: "shape", form: "rect", x: 10, y: 20, w: 100, h: 50, ...more }) as BoardObject;

test("a shape is on the board as a box is: relative to its frame in the store, on the canvas in the window", () => {
  assert.equal(isBox(drawnShape("s")), true);
  assert.equal(isBoxType("shape"), true);
  const frames = [{ id: "f", x: 100, y: 200, w: 500, h: 500 }] as FrameState[];
  const stored = [drawnShape("s", { frame: "f" })];
  const canvas = toCanvas(stored, frames);
  assert.deepEqual(canvas[0], drawnShape("s", { frame: "f", x: 110, y: 220 }));
  assert.deepEqual(toStored(canvas, frames), stored);
  // Its frame gone, it stays where it is, loose.
  assert.deepEqual(toStored(canvas, []), [drawnShape("s", { x: 110, y: 220 })]);
});

test("selecting a shape of a drawing is selecting the drawing, and a shape alone is itself", () => {
  const board = [drawnShape("a", { drawing: "d" }), drawnShape("b", { drawing: "d" }), drawnShape("c", { drawing: "other" }), drawnShape("loose")];
  assert.deepEqual(groupOf(board, "b"), ["a", "b"]);
  assert.deepEqual(groupOf(board, "loose"), ["loose"]);
  assert.deepEqual(groupOf(board, "nothing"), ["nothing"]);
});

test("what a board action answered is one edit: changed objects keep their place, taken ones go, new ones come last", () => {
  const board = [drawnShape("a"), drawnShape("b"), drawnShape("c")];
  // Nothing answered: the same board, so nothing is written and no undo step is made.
  assert.equal(withChanges(board, {}), board);
  const moved = drawnShape("b", { x: 99 });
  const next = withChanges(board, { b: moved, c: null, d: drawnShape("d") });
  assert.deepEqual(next.map((o) => o.id), ["a", "b", "d"]);
  assert.equal(next[0], board[0]);
  assert.equal(next[1], moved);
});

test("a board where nothing changed is the same board, and an edit leaves every other object as it was", () => {
  const stroke = drawnShape("pen", { form: "pen", frame: "f", points: [[0, 0], [40, 30], [80, 10]] });
  const stored = [stroke, drawnShape("box", { frame: "f" }), note()];
  const kept = keepUnchanged([], stored);
  // The frame moves and its drawing goes along: nothing kept changed, so there is nothing to save.
  const moved = toCanvas(stored, [frame({ x: 300, y: 60 })]).map((o) => ({ ...o }));
  assert.equal(keepUnchanged(kept, toStored(moved, [frame({ x: 300, y: 60 })])), kept);
  // One box recoloured: it alone is new.
  const edited = keepUnchanged(kept, toStored(moved.map((o) => (o.id === "box" ? { ...o, color: "red" } : o)) as BoardObject[], [frame({ x: 300, y: 60 })]));
  assert.notEqual(edited, kept);
  assert.deepEqual(edited.map((o, i) => o === kept[i]), [true, false, true]);
});

test("picking a drawing tool brings the drawing tools out, and putting them away goes back to Select", () => {
  const off = { tool: "select", on: false } as const;
  assert.deepEqual(pickTool(off, "rect"), { tool: "rect", on: true }, "a tool key turns Draw on");
  assert.equal(pickTool(off, "select"), off, "Select alone leaves Draw as it was");
  const drawing = { tool: "pen", on: true } as const;
  assert.deepEqual(pickTool(drawing, "select"), { tool: "select", on: true }, "Esc back to Select keeps the row out");
  assert.deepEqual(showDrawing(drawing, false), { tool: "select", on: false }, "Draw off puts the pen down");
  assert.deepEqual(showDrawing(off, true), { tool: "select", on: true });
  assert.equal(showDrawing(drawing, true), drawing, "nothing changed, the same object");
});

test("what another writer or an undo took off the board is no longer selected or written in; a selection all still there is the same one", () => {
  const board = [note({ id: "n1" }), note({ id: "n2" })];
  const chosen = { selectedId: "n1", selectedIds: ["n1", "n2"], editingId: "n2" };
  assert.equal(selectionOn(board, chosen), chosen);
  assert.deepEqual(selectionOn([note({ id: "n2" })], chosen), { selectedId: "n2", selectedIds: ["n2"], editingId: "n2" });
  assert.deepEqual(selectionOn([note({ id: "n1" })], chosen), { selectedId: "n1", selectedIds: ["n1"], editingId: null });
  assert.deepEqual(selectionOn([], chosen), { selectedId: null, selectedIds: [], editingId: null });
  const none = { selectedId: null, selectedIds: [], editingId: null };
  assert.equal(selectionOn([], none), none);
});

test("selecting every shape keeps a big painted selection painted; a few are shown as their nodes, and a tile always is", () => {
  const painted = (id: string): Node => ({ id, type: "shape", position: { x: 0, y: 0 }, data: {}, hidden: true });
  const tile: Node = { id: "t1", type: "terminal", position: { x: 0, y: 0 }, data: {} };
  const many = Array.from({ length: 2000 }, (_, i) => painted(`s${i}`));
  const all = withSelected([tile, ...many], new Set(["t1", ...many.map((n) => n.id)]));
  assert.equal(all.filter((n) => !n.hidden).length, 1, "only the tile is a shown node");
  assert.ok(all.every((n) => n.selected), "every one is selected");
  const few = withSelected(many, new Set(["s1", "s2"]));
  assert.deepEqual(few.filter((n) => !n.hidden).map((n) => n.id), ["s1", "s2"]);
  const bound = withSelected(many, new Set(many.slice(0, SHOWN_SELECTED_MOST).map((n) => n.id)));
  assert.equal(bound.filter((n) => !n.hidden).length, SHOWN_SELECTED_MOST);
});
