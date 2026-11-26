// The board's drawings as Layers rows (layer-drawings.ts): one row per drawing, named by what it
// says, a frame's loose shapes as one row, and the same rows back while nothing they show changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import { drawingRows, newDrawings, objectsIn } from "../../src/renderer/src/layer-drawings.ts";

const shape = (id: string, over: Record<string, unknown> = {}): BoardObject =>
  ({ id, kind: "shape", form: "rect", x: 0, y: 0, w: 10, h: 10, ...over }) as BoardObject;
const arrow = (id: string, over: Record<string, unknown> = {}): BoardObject =>
  ({ id, kind: "arrow", from: { id: "a", side: "right" }, to: { id: "b", side: "left" }, label: "", ...over }) as BoardObject;
const note = (id: string): BoardObject => ({ id, kind: "widget", widget: "note", placement: "board", x: 0, y: 0, w: 10, h: 10, text: "a note" }) as BoardObject;
const rows = (objects: BoardObject[]) => drawingRows(objects).list.map((r) => [r.key, r.name, r.detail, r.frameId]);

test("a drawing is named by its largest text, the first of the largest; its detail says how many shapes", () => {
  assert.deepEqual(rows([
    shape("s1", { drawing: "d1", text: "box" }), shape("s2", { drawing: "d1", form: "text", size: "large", text: "Checkout\nmore" }),
    shape("s3", { drawing: "d2", form: "text", size: "small", text: "small" }), shape("s4", { drawing: "d2", text: " first \nsecond" }), shape("s5", { drawing: "d2", form: "text", size: "medium", text: "medium" }),
  ]), [["d1", "Checkout", "2 shapes", null], ["d2", "first", "3 shapes", null]]);
});

test("a drawing with no text is named by what it is: a lone arrow by its label, box, pen stroke, or how many shapes", () => {
  assert.deepEqual(rows([
    arrow("a1", { drawing: "d1", label: "only" }),
    shape("s1", { drawing: "d2" }),
    shape("s2", { drawing: "d3", form: "pen" }),
    shape("s3", { drawing: "d4", form: "line", head: true }),
    shape("s4", { drawing: "d5" }), arrow("a2", { drawing: "d5" }), shape("s5", { drawing: "d5", form: "ellipse" }),
  ]), [["d1", "only", "", null], ["d2", "Box", "", null], ["d3", "Pen stroke", "", null], ["d4", "Arrow", "", null], ["d5", "3 shapes", "", null]]);
  assert.deepEqual(rows([shape("s6", { drawing: "d6", form: "ellipse", text: "Cache" })]), [["d6", "Cache", "Ellipse", null]]);
});

test("shapes in no drawing are one Shapes row per frame, or the one shape's own; notes and plain arrows are no row", () => {
  assert.deepEqual(rows([shape("s1", { frame: "f1", text: "loose words" }), note("n1"), arrow("a1", { label: "joins" }), shape("s2", { frame: "f1" }), shape("s3", { form: "star" }), shape("s4", { frame: "f2", drawing: "d1" })]),
    [["shapes:f1", "Shapes", "2 shapes", "f1"], ["shapes:", "Star", "", null], ["d1", "Box", "", "f2"]]);
});

test("a row keeps its frame, who drew it, a shape to go to, and every text in it for search; an arrow's label names only a lone arrow", () => {
  const [row] = drawingRows([arrow("a1", { drawing: "d1", label: "Retries", by: "tile-7" }), shape("s1", { drawing: "d1", frame: "f1", text: "Queue" })]).list;
  assert.deepEqual(row, { key: "d1", name: "Queue", detail: "2 shapes", frameId: "f1", by: "tile-7", objectId: "s1", text: "queue\nretries\nqueue", lockable: true, locked: false });
  assert.deepEqual(drawingRows([arrow("a2", { drawing: "d2", label: "only" })]).list.map((r) => [r.name, r.objectId]), [["only", "a2"]]);
  assert.deepEqual(drawingRows([shape("s1", { drawing: "d1" }), shape("s2", { drawing: "d1", frame: "f1" })]).byFrame.get("f1")?.map((r) => r.key), ["d1"]);
});

test("locked only when every shape in it is; arrows alone cannot be locked", () => {
  const lock = (objects: BoardObject[]) => drawingRows(objects).list.map((r) => [r.key, r.lockable, r.locked]);
  assert.deepEqual(lock([
    shape("s1", { drawing: "d1", locked: true }), arrow("a1", { drawing: "d1" }),
    shape("s2", { drawing: "d2", locked: true }), shape("s3", { drawing: "d2" }),
    arrow("a2", { drawing: "d3" }),
  ]), [["d1", true, true], ["d2", true, false], ["d3", false, false]]);
});

test("objectsIn gives every object of the rows asked for, loose shapes by their frame's row, and nothing else", () => {
  const objects = [shape("s1", { drawing: "d1" }), arrow("a1", { drawing: "d1" }), shape("s2", { frame: "f1" }), shape("s3"), arrow("a2"), note("n1"), shape("s4", { drawing: "d2" })];
  assert.deepEqual(objectsIn(objects, new Set(["d1", "shapes:f1"])), ["s1", "a1", "s2"]);
});

test("locking a shape gives a new row; a row whose lock did not change is kept", () => {
  const first = drawingRows([shape("s1", { drawing: "d1" }), shape("s2", { drawing: "d2" })]);
  const next = drawingRows([shape("s1", { drawing: "d1", locked: true }), shape("s2", { drawing: "d2" })], first);
  assert.equal(next.list[0]!.locked, true);
  assert.equal(next.list[1], first.list[1]);
});

test("moved objects give back the same rows; a changed text gives a new row and keeps the rest", () => {
  const objects = [shape("s1", { drawing: "d1", text: "A" }), shape("s2", { drawing: "d2", text: "B" })];
  const first = drawingRows(objects);
  assert.equal(drawingRows(objects.map((o) => ({ ...o, x: 50 }) as BoardObject), first), first);
  const next = drawingRows([objects[0]!, shape("s2", { drawing: "d2", text: "C" })], first);
  assert.notEqual(next, first);
  assert.equal(next.list[0], first.list[0]);
  assert.equal(next.list[1]!.name, "C");
  assert.notEqual(drawingRows([objects[0]!], first), first);
});

test("5000 objects moved or copied give back the same rows; one changed text gives one new row", () => {
  const objects: BoardObject[] = [];
  for (let i = 0; i < 5000; i++) {
    const d = i % 10 === 0 ? undefined : `d${Math.floor(i / 10)}`;
    objects.push(shape(`s${i}`, { frame: `f${i % 20}`, ...(d ? { drawing: d } : {}), text: i % 3 ? `label ${i}` : undefined, ...(i % 50 === 1 ? { form: "text", size: "large" } : {}) }));
  }
  const first = drawingRows(objects);
  assert.equal(first.list.length, 502);
  assert.equal(drawingRows(objects.map((o) => ({ ...o, x: 7 }) as BoardObject), first), first);
  const changed = objects.slice();
  changed[11] = { ...changed[11]!, text: "renamed" } as BoardObject;
  const next = drawingRows(changed, first);
  const renewed = next.list.filter((row, i) => row !== first.list[i]);
  assert.deepEqual(renewed.map((r) => r.key), ["d1"]);
});

test("newDrawings gives the shapes of each drawing not yet known, and nothing when all are", () => {
  const objects = [shape("s1", { drawing: "d1" }), note("n1"), shape("s2", { drawing: "d2" }), shape("s3"), arrow("a1", { drawing: "d2" }), shape("s4", { drawing: "d2" })];
  assert.deepEqual([...newDrawings(objects, new Set(["d1"]))!].map(([id, shapes]) => [id, shapes.map((o) => o.id)]), [["d2", ["s2", "s4"]]]);
  assert.equal(newDrawings(objects, new Set(["d1", "d2"])), null);
});

test("a lone arrow's row is named by what it joins, with its label beside it", () => {
  const nameOf = (id: string) => ({ s1: "API", "tile-1": "Claude" } as Record<string, string>)[id];
  const [row] = drawingRows([arrow("a1", { drawing: "d1", label: "calls", from: { id: "s1", side: "right" }, to: { id: "tile-1", side: "left" } })], undefined, nameOf).list;
  assert.deepEqual([row!.name, row!.detail], ["API → Claude", "calls"]);
});
