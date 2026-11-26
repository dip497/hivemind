// The board's actions, as the window and the API both do them: only what changed comes back.
import { expect, test } from "bun:test";
import { alignObjects, duplicateObjects, lockObjects, moveObjects, restack, styleObjects } from "../src/board-actions.ts";
import { MAX_SHAPES_ON_BOARD } from "../src/drawing.ts";
import type { BoardObject, ShapeObject } from "../src/shapes.ts";

const shape = (id: string, x: number, y: number, more: Partial<ShapeObject> = {}): ShapeObject => ({ id, kind: "shape", form: "rect", x, y, w: 100, h: 50, ...more });

test("restack puts the chosen in front or behind, keeping their order, and leaves the rest", () => {
  const board = [shape("a", 0, 0, { z: 1 }), shape("b", 0, 0, { z: 2 }), shape("c", 0, 0, { z: 3 }), shape("d", 0, 0, { z: 4 })];
  const front = restack(board, ["a", "b"], "front");
  expect(Object.keys(front).sort()).toEqual(["a", "b"]);
  expect([front.a!.z, front.b!.z]).toEqual([5, 6]);
  const back = restack(board, ["c", "d"], "back");
  expect([back.c!.z, back.d!.z]).toEqual([-2, -1]);
  // Already in front: nothing to write.
  expect(restack(board, ["d"], "front")).toEqual({});
});

test("align moves only what is out of line, and never a locked shape", () => {
  const board = [shape("a", 10, 0), shape("b", 40, 100), shape("c", 70, 200, { locked: true }), shape("d", 10, 300)];
  const moved = alignObjects(board, ["a", "b", "c", "d"], "left");
  expect(Object.keys(moved)).toEqual(["b"]);
  expect((moved.b as ShapeObject).x).toBe(10);
});

test("move keeps the chosen as they are to each other and leaves a locked shape", () => {
  const board = [shape("a", 0, 0), shape("b", 200, 100), shape("c", 50, 50, { locked: true })];
  const moved = moveObjects(board, ["a", "b", "c"], { x: 1000, y: 1000 });
  expect(Object.keys(moved).sort()).toEqual(["a", "b"]);
  expect([(moved.a as ShapeObject).x, (moved.b as ShapeObject).x, (moved.b as ShapeObject).y]).toEqual([1000, 1200, 1100]);
});

test("lock changes only what it flips; style gives an arrow only its colour, dash and weight", () => {
  const board: BoardObject[] = [shape("a", 0, 0), shape("b", 0, 0, { locked: true }), { id: "r", kind: "arrow", label: "", from: { id: "a", side: "right" }, to: { id: "b", side: "left" } }];
  expect(Object.keys(lockObjects(board, ["a", "b"], true))).toEqual(["a"]);
  expect("locked" in lockObjects(board, ["b"], false).b!).toBe(false);
  const styled = styleObjects(board, ["a", "r"], { color: "red", filled: true });
  expect((styled.a as ShapeObject).filled).toBe(true);
  expect(styled.r).toEqual({ ...board[2]!, color: "red" } as BoardObject);
});

test("duplicate copies a drawing as a drawing of its own, unlocked, with the arrows between its boxes", () => {
  const board: BoardObject[] = [
    shape("a", 0, 0, { drawing: "d1", locked: true, z: 3 }), shape("b", 200, 0, { drawing: "d1" }),
    { id: "r", kind: "arrow", label: "", drawing: "d1", from: { id: "a", side: "right" }, to: { id: "b", side: "left" } },
  ];
  let n = 0;
  const copies = Object.values(duplicateObjects(board, ["a", "b"], (kind) => `${kind}-${++n}`, 24, 24)) as BoardObject[];
  expect(copies.length).toBe(3);
  const [a, , r] = copies as [ShapeObject, ShapeObject, BoardObject];
  expect([a.x, a.y, a.locked, a.z]).toEqual([24, 24, undefined, 4]);
  expect(a.drawing).not.toBe("d1");
  expect(r.kind === "arrow" && r.from.id === a.id && r.drawing === a.drawing).toBe(true);
});

test("duplicate is refused when the board would hold more shapes than it takes", () => {
  const board = Array.from({ length: MAX_SHAPES_ON_BOARD }, (_, i) => shape(`s${i}`, i, 0));
  expect(() => duplicateObjects(board, ["s0"], (kind) => `${kind}-new`, 24, 24)).toThrow(TypeError);
  expect(Object.keys(duplicateObjects(board.slice(1), ["s1"], (kind) => `${kind}-new`, 24, 24))).toEqual(["shape-new"]);
});
