// Frames inside frames: which page a frame is in, what is inside a frame, and the path down to one.
import { expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt";
import { readCore, writeCore } from "../src/core.ts";
import { FRAMES as FRAME_TREE } from "../src/schema.ts";
import { ancestorsOf, framesWithin, isWithin, pageOf } from "../src/pages.ts";
import type { FrameRecord } from "../src/shapes.ts";

const frame = (id: string, fields: Partial<FrameRecord> = {}): FrameRecord => ({ id, title: id, ...fields });

// Payments (page) › Checkout (page) › Cart (a plain frame) › Basket ; Infra at the top.
const FRAMES: FrameRecord[] = [
  frame("payments", { page: true }),
  frame("checkout", { page: true, parentFrameId: "payments" }),
  frame("cart", { parentFrameId: "checkout" }),
  frame("basket", { parentFrameId: "cart" }),
  frame("infra"),
];

test("pageOf is the nearest page at or above a frame, four deep", () => {
  expect(pageOf(FRAMES, "basket")).toBe("checkout");
  expect(pageOf(FRAMES, "checkout")).toBe("checkout");
  expect(pageOf(FRAMES, "payments")).toBe("payments");
  expect(pageOf(FRAMES, "infra")).toBeNull();
  expect(pageOf(FRAMES, undefined)).toBeNull();
});

test("a frame is within itself and every frame above it, at any depth, and nothing else", () => {
  expect(isWithin(FRAMES, "basket", "payments")).toBe(true);
  expect(isWithin(FRAMES, "basket", "basket")).toBe(true);
  expect(isWithin(FRAMES, "payments", "basket")).toBe(false);
  expect(isWithin(FRAMES, "infra", "payments")).toBe(false);
  expect(isWithin(FRAMES, undefined, "payments")).toBe(false);
  expect([...framesWithin(FRAMES, "checkout")].sort()).toEqual(["basket", "cart", "checkout"]);
  expect([...framesWithin(FRAMES, "nothing")]).toEqual([]);
});

test("the path down to a frame names every frame holding it, from the top", () => {
  expect(ancestorsOf(FRAMES, "basket")).toEqual(["payments", "checkout", "cart"]);
  expect(ancestorsOf(FRAMES, "payments")).toEqual([]);
  expect(ancestorsOf(FRAMES, "nothing")).toEqual([]);
});

test("frames whose parents make a cycle are read at the top level, and nothing loops", () => {
  const cycle = [frame("a", { page: true, parentFrameId: "b" }), frame("b", { page: true, parentFrameId: "a" }), frame("c", { parentFrameId: "a" })];
  expect(pageOf(cycle, "c")).toBe("a");
  expect(ancestorsOf(cycle, "c")).toEqual(["a"]);
  expect([...framesWithin(cycle, "a")].sort()).toEqual(["a", "b", "c"]);
  expect([...framesWithin(cycle, "b")]).toEqual(["b"]);
});

test("a page is kept in the document, and anything else in its place is not", () => {
  const doc = new LoroDoc();
  writeCore(doc, { frames: [frame("p", { page: true }), frame("q"), frame("r")], tiles: [] });
  // As another writer might have stored it.
  const q = doc.getTree(FRAME_TREE).roots().find((n) => n.data.get("id") === "q")!;
  q.data.set("page", "yes");
  doc.commit();
  const frames = readCore(doc)!.frames;
  expect(frames.find((f) => f.id === "p")!.page).toBe(true);
  expect("page" in frames.find((f) => f.id === "q")!).toBe(false);
  expect("page" in frames.find((f) => f.id === "r")!).toBe(false);
});
