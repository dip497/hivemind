// What an agent asks to have drawn, where it goes, what a shape's outline and hit are, and the
// picture of the board: the rules each reader of a drawing depends on, with nothing faked.
import { expect, test } from "bun:test";
import {
  MAX_SHAPES_DRAWN, boardPicture, boxSizeFor, freeCorner, inkOf, placeBoxes, readDrawAsked, rectsTouch, scaledPoints, shapeHit, shapeOutline,
  simplifyPoints, sketchOf, strokeBox, wrapLines, type DrawnBox, type Rect,
} from "../src/drawing.ts";
import { MAX_SHAPE_POINTS, type BoardObject, type ShapeObject } from "../src/shapes.ts";
import { drawingName, endNamer } from "../src/drawing-name.ts";

const boxes = (...ids: string[]): DrawnBox[] => ids.map((id) => ({ id, text: id }));
const links = (...pairs: Array<[string, string]>) => pairs.map(([from, to]) => ({ from, to }));
const shape = (o: Partial<ShapeObject>): ShapeObject => ({ id: "s", kind: "shape", form: "rect", x: 0, y: 0, w: 100, h: 50, ...o });

test("boxes go in ranks along the links, a target after its source, with none on another", () => {
  const places = placeBoxes(boxes("a", "b", "c", "d", "e"), links(["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "e"]));
  const at = (id: string) => places.get(id)!;
  expect(at("a").x + at("a").w).toBeLessThan(at("b").x);
  expect(at("b").x).toBe(at("c").x);
  expect(at("c").x + at("c").w).toBeLessThan(at("d").x);
  expect(at("d").x + at("d").w).toBeLessThan(at("e").x);
  const all = [...places.values()];
  all.forEach((r, i) => all.slice(i + 1).forEach((o) => expect(rectsTouch(r, o)).toBe(false)));

  const down = placeBoxes(boxes("a", "b"), links(["a", "b"]), "down");
  expect(down.get("a")!.y + down.get("a")!.h).toBeLessThan(down.get("b")!.y);
});

test("a rank is ordered to keep links short, and a link that closes a cycle draws without ranking", () => {
  // x and y lead to their own target: left in the order given, their links would cross.
  const places = placeBoxes(boxes("x", "y", "toY", "toX"), links(["x", "toX"], ["y", "toY"]));
  expect(places.get("toX")!.y).toBeLessThan(places.get("toY")!.y);

  const cycle = placeBoxes(boxes("a", "b", "c"), links(["a", "b"], ["b", "c"], ["c", "a"]));
  expect(cycle.size).toBe(3);
  expect(cycle.get("a")!.x).toBeLessThan(cycle.get("b")!.x);
  expect(cycle.get("b")!.x).toBeLessThan(cycle.get("c")!.x);
});

test("a box is big enough for its words, and a word too long for one line is broken", () => {
  expect(boxSizeFor("a short one").h).toBe(56);
  const long = boxSizeFor("many more words than any one line of a box can hold at once");
  expect(long.h).toBeGreaterThan(56);
  expect(long.w).toBeLessThanOrEqual(280);
  expect(wrapLines("x".repeat(30), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(10)]);
  expect(wrapLines("one two\nthree", 40)).toEqual(["one two", "three"]);
});

test("what may be drawn is read, and what may not says why", () => {
  const read = readDrawAsked({ title: "T", boxes: [{ id: "a", text: "A", color: "blue" }], links: [["a", "tile-1", "goes"]], shapes: [{ form: "line", points: [[0, 0], [5, 5]], head: true }], at: { x: 1, y: 2 } });
  expect(read.links).toEqual([{ from: "a", to: "tile-1", label: "goes" }]);
  expect(read.shapes![0]).toMatchObject({ form: "line", head: true });

  const refused = (asked: unknown, why: string) => expect(() => readDrawAsked(asked)).toThrow(why);
  refused([], "must be an object");
  refused({}, "nothing to draw");
  refused({ boxes: [{ text: "no id" }] }, "boxes[0].id");
  refused({ boxes: [{ id: "a", text: "A" }, { id: "a", text: "B" }] }, "an id of its own");
  refused({ boxes: [{ id: "a", text: "A", color: "#ff0000" }] }, "boxes[0].color");
  refused({ boxes: [{ id: "a", text: "A", form: "blob" }] }, "boxes[0].form");
  refused({ links: [["a"]] }, "links[0]");
  refused({ shapes: [{ form: "pen", points: [[0, 0]] }] }, "shapes[0].points");
  refused({ shapes: [{ form: "pen", points: Array.from({ length: MAX_SHAPE_POINTS + 1 }, () => [0, 0]) }] }, "shapes[0].points");
  refused({ shapes: [{ form: "rect", x: "left" }] }, "shapes[0].x");
  refused({ shapes: [{ form: "text" }] }, "say it");
  refused({ boxes: Array.from({ length: MAX_SHAPES_DRAWN }, (_, i) => ({ id: `b${i}`, text: "" })) }, "at most");
  refused({ boxes: [{ id: "a", text: "x".repeat(2001) }] }, "boxes[0].text");
  refused({ boxes: boxes("a"), direction: "up" }, "direction");
});

test("a title goes above the boxes, and shapes go where they say from the same corner", () => {
  const sketch = sketchOf({ title: "Flow", boxes: boxes("a"), links: [], shapes: [{ form: "rect", x: 300, y: 10, w: 40, h: 40 }, { form: "line", points: [[0, 100], [50, 150]] }] });
  const [title, box, rect, line] = sketch.shapes;
  expect(title).toMatchObject({ form: "text", text: "Flow", size: "large", y: 0 });
  expect(box!.y).toBeGreaterThanOrEqual(title!.h);
  expect(box).toMatchObject({ box: "a", filled: true });
  expect(rect).toMatchObject({ x: 300, w: 40 });
  expect(rect!.y).toBe(box!.y + 10);
  expect(line).toMatchObject({ x: 0, w: 50, h: 50, points: [[0, 0], [50, 50]] });
  expect(sketch.size.w).toBe(340);
});

test("a free corner keeps clear of what is on the canvas", () => {
  const taken: Rect[] = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 0, w: 100, h: 100 }];
  const corner = freeCorner({ x: 0, y: 0 }, { w: 200, h: 80 }, taken);
  taken.forEach((t) => expect(rectsTouch({ ...corner, w: 200, h: 80 }, t)).toBe(false));
  expect(freeCorner({ x: 0, y: 500 }, { w: 200, h: 80 }, taken)).toEqual({ x: 0, y: 500 });
});

test("a hand's points thin to the line they draw, keeping its ends, and never more than a shape keeps", () => {
  const straight = Array.from({ length: 100 }, (_, i): [number, number] => [i, i]);
  expect(simplifyPoints(straight, 0.5)).toEqual([[0, 0], [99, 99]]);
  const bend: Array<[number, number]> = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
  expect(simplifyPoints(bend, 0.5)).toEqual([[0, 0], [100, 0], [100, 100]]);
  const wild = Array.from({ length: MAX_SHAPE_POINTS * 2 }, (_, i): [number, number] => [i, i % 2 === 0 ? 0 : 50]);
  const thinned = simplifyPoints(wild, 0.5);
  expect(thinned.length).toBeLessThanOrEqual(MAX_SHAPE_POINTS);
  expect(thinned[0]).toEqual(wild[0]!);
  expect(thinned.at(-1)).toEqual(wild.at(-1)!);
});

test("a stroke's box holds its points from its corner, and they scale with it", () => {
  const box = strokeBox([[10, 20], [30, 25], [20, 60]]);
  expect(box).toEqual({ x: 10, y: 20, w: 20, h: 40, points: [[0, 0], [20, 5], [10, 40]] });
  expect(scaledPoints(box.points, box, { w: 40, h: 20 })).toEqual([[0, 0], [40, 2.5], [20, 20]]);
  // A flat line has a box, and stays flat.
  const flat = strokeBox([[0, 5], [10, 5]]);
  expect(flat.h).toBe(1);
  expect(scaledPoints(flat.points, flat, { w: 20, h: 50 })).toEqual([[0, 0], [20, 0]]);
});

test("a click lands on what is drawn: the edge of a hollow shape, anywhere on a filled or written one, along a stroke", () => {
  const hollow = shape({ x: 100, y: 100 });
  expect(shapeHit(hollow, { x: 100, y: 120 }, 4)).toBe(true);
  expect(shapeHit(hollow, { x: 150, y: 125 }, 4)).toBe(false);
  expect(shapeHit(hollow, { x: 90, y: 120 }, 4)).toBe(false);
  expect(shapeHit({ ...hollow, filled: true }, { x: 150, y: 125 }, 4)).toBe(true);
  expect(shapeHit({ ...hollow, text: "api" }, { x: 150, y: 125 }, 4)).toBe(true);
  const ellipse = shape({ form: "ellipse" });
  expect(shapeHit(ellipse, { x: 50, y: 0 }, 2)).toBe(true);
  expect(shapeHit(ellipse, { x: 50, y: 25 }, 2)).toBe(false);
  const diamond = shape({ form: "diamond" });
  expect(shapeHit(diamond, { x: 25, y: 12.5 }, 2)).toBe(true);
  expect(shapeHit(diamond, { x: 50, y: 25 }, 2)).toBe(false);
  const pen = shape({ form: "pen", points: [[0, 0], [100, 50]] });
  expect(shapeHit(pen, { x: 50, y: 25 }, 2)).toBe(true);
  expect(shapeHit(pen, { x: 90, y: 5 }, 2)).toBe(false);
});

test("each form has one outline, and text has none", () => {
  expect(shapeOutline(shape({ form: "rect" }))).toStartWith("M");
  expect(shapeOutline(shape({ form: "ellipse" }))).toContain("A");
  expect(shapeOutline(shape({ form: "diamond" }))).toEndWith("Z");
  expect(shapeOutline(shape({ form: "text" }))).toBe("");
  expect(shapeOutline(shape({ form: "line", points: [[0, 0], [5, 5]] }))).toBe("M0 0L5 5");
  expect(shapeOutline(shape({ form: "pen", points: [[0, 0], [10, 0], [20, 10]] }))).toContain("Q");
});

test("the picture holds what is drawn, on the theme asked for, and nothing in it can run", () => {
  const objects: BoardObject[] = [
    shape({ id: "a", text: `<script>alert(1)</script> & "more"`, color: "blue", filled: true }),
    shape({ id: "b", x: 300, text: "B" }),
    { id: "l", kind: "arrow", label: "goes<>", from: { id: "a", side: "right" }, to: { id: "b", side: "left" } },
    { id: "m", kind: "arrow", label: "", from: { id: "a", side: "right" }, to: { id: "gone", side: "left" } },
    { id: "t", kind: "arrow", label: "", from: { id: "b", side: "right" }, to: { id: "tile-1", side: "left" } },
  ];
  const dark = boardPicture(objects, [{ id: "tile-1", x: 600, y: 0, w: 200, h: 100, name: "Claude <1>" }], "dark");
  expect(dark.svg).toStartWith("<svg");
  expect(dark.svg).not.toContain("<script");
  expect(dark.svg).toContain("&#60;script&#62;");
  expect(dark.svg).toContain("Claude &#60;1&#62;");
  expect(dark.svg).toContain(inkOf("blue", "dark"));
  expect(dark.svg).not.toContain("href");
  // Two arrows land; the one whose end is gone is not drawn.
  expect(dark.svg.match(/marker-end/g)).toHaveLength(2);
  expect(dark.width).toBe(800 + 64);
  const light = boardPicture(objects, [], "light");
  expect(light.svg).toContain(inkOf("blue", "light"));
  expect(light.svg).not.toContain(inkOf("blue", "dark"));
  expect(boardPicture([], []).svg).toStartWith("<svg");
});

test("a colour no theme knows is drawn as ink", () => {
  expect(inkOf("chartreuse", "dark")).toBe(inkOf("ink", "dark"));
  expect(inkOf(undefined, "light")).toBe(inkOf("ink", "light"));
});

test("a drawing is named by its largest writing, the first of the largest, else by what it is", () => {
  const box = (id: string, text?: string, size?: "small" | "medium" | "large"): ShapeObject => ({ id, kind: "shape", form: "rect", x: 0, y: 0, w: 10, h: 10, ...(text ? { text } : {}), ...(size ? { size } : {}) });
  expect(drawingName([box("a", "Small", "small"), box("b", "Middle\nsecond line"), box("c", "Also middle")])).toBe("Middle");
  expect(drawingName([box("a", "Middle"), box("b", "Big", "large"), box("c", "Bigger", "large")])).toBe("Big");
  const arrow: BoardObject = { id: "x", kind: "arrow", label: "calls", from: { id: "a", side: "right" }, to: { id: "b", side: "left" } };
  expect(drawingName([arrow])).toBe("calls");
  expect(drawingName([{ ...arrow, label: "" }])).toBe("Arrow");
  expect(drawingName([box("a"), box("b"), arrow])).toBe("3 shapes");
  expect(drawingName([{ ...box("p"), form: "pen", points: [[0, 0], [1, 1]] }])).toBe("Pen stroke");
});

test("a lone arrow is named by what it joins, a shape's words or a tile's name, before its label", () => {
  const api: ShapeObject = { id: "api", kind: "shape", form: "rect", x: 0, y: 0, w: 10, h: 10, text: "API\nserves the app" };
  const arrow: BoardObject = { id: "x", kind: "arrow", label: "calls", from: { id: "api", side: "right" }, to: { id: "tile-1", side: "left" } };
  const nameOf = endNamer([api, arrow], [{ id: "tile-1", name: "Claude" }]);
  expect(drawingName([arrow], nameOf)).toBe("API → Claude");
  expect(drawingName([{ ...arrow, to: { id: "gone", side: "left" } }], nameOf)).toBe("API → ?");
  expect(drawingName([{ ...arrow, from: { id: "gone", side: "left" }, to: { id: "gone", side: "left" } }], nameOf)).toBe("calls");
});
