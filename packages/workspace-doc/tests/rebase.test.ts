// A write from an older reading (src/rebase.ts through writeCore): a window saves its whole core
// layout, made from what it last read. Another writer changed the document since; the window's
// write keeps its own changes and leaves everyone else's as they are.
import { expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt";
import { addTile, readCore, removeTile, writeCore, writeTileName } from "../src/core.ts";
import { readObjects, writeObjects } from "../src/objects.ts";
import { readView, writeView } from "../src/views.ts";
import type { BoardObject } from "../src/shapes.ts";

type Fields = Record<string, unknown>;
const frame = (id: string, fields: Fields = {}) => ({ id, x: 0, y: 0, w: 400, h: 300, title: id, color: "#888", z: 1, ...fields });
const tile = (id: string, fields: Fields = {}) => ({ id, kind: "shell", label: id, ...fields });

const READ = {
  frames: [frame("f1"), frame("f2"), frame("f3", { workspacePath: "/work/web" })],
  tiles: [tile("t1"), tile("t2"), tile("t3"), tile("ed", { kind: "editor" })],
  tileNames: { t1: "api" },
  editorTabs: { ed: ["a.ts"] },
  frameOf: { t1: "f1", t2: "f2", t3: "f2" },
};

test("a write from an older reading changes what its writer changed, and keeps what others changed since", () => {
  const doc = new LoroDoc();
  writeCore(doc, READ);
  // Another writer, since: names t2, moves f2, opens a tab in ed, closes t3 and opens t4 in f3.
  writeTileName(doc, "t2", "server");
  writeCore(doc, {
    ...READ,
    frames: [frame("f1"), frame("f2", { x: 500 }), frame("f3", { workspacePath: "/work/web" })],
    tiles: [tile("t1"), tile("t2"), tile("ed", { kind: "editor" }), tile("t4")],
    tileNames: { t1: "api", t2: "server" },
    editorTabs: { ed: ["a.ts", "b.ts"] },
    frameOf: { t1: "f1", t2: "f2", t4: "f3" },
  });
  // The window, still on what it read: moves f1, unbinds f3, renames t1, closes t2, opens t5.
  writeCore(doc, {
    frames: [frame("f1", { x: 80 }), frame("f2"), frame("f3")],
    tiles: [tile("t1"), tile("t3"), tile("ed", { kind: "editor" }), tile("t5")],
    tileNames: { t1: "api shell" },
    editorTabs: { ed: ["a.ts"] },
    frameOf: { t1: "f1", t3: "f2", t5: "f3" },
  }, READ);
  expect(readCore(doc)).toEqual({
    frames: [frame("f1", { x: 80 }), frame("f2", { x: 500 }), frame("f3")],
    // The window's order, then what another writer opened; t3, closed since, stays closed.
    tiles: [tile("t1"), tile("ed", { kind: "editor" }), tile("t5"), tile("t4")],
    tileNames: { t1: "api shell" },
    editorTabs: { ed: ["a.ts", "b.ts"] },
    frameOf: { t1: "f1", t5: "f3", t4: "f3" },
  });
});

test("a writer that read nothing keeps what is there; a write with no reading is the layout as given", () => {
  const doc = new LoroDoc();
  writeCore(doc, READ);
  writeCore(doc, { frames: [frame("f9")], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} }, null);
  expect(readCore(doc)?.frames.map((f) => f.id)).toEqual(["f9", "f1", "f2", "f3"]);
  expect(readCore(doc)?.tiles.map((t) => t.id)).toEqual(["t1", "t2", "t3", "ed"]);
  writeCore(doc, { frames: [frame("f9")], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} });
  expect(readCore(doc)).toEqual({ frames: [frame("f9")], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} });
});

test("a tile is named, and its name taken away, on its own; a tile the document does not hold is not", () => {
  const doc = new LoroDoc();
  writeCore(doc, READ);
  expect(writeTileName(doc, "t2", "server")).toBe(true);
  expect(readCore(doc)?.tileNames).toEqual({ t1: "api", t2: "server" });
  expect(writeTileName(doc, "t1", "")).toBe(true);
  expect(readCore(doc)?.tileNames).toEqual({ t2: "server" });
  expect(writeTileName(doc, "gone", "x")).toBe(false);
  expect(readCore(doc)?.tiles.map((t) => t.id)).toEqual(["t1", "t2", "t3", "ed"]);
});

test("a tile is taken out on its own, with its name, tabs and frame, leaving nothing behind; a tile the document does not hold is not", () => {
  const doc = new LoroDoc();
  writeCore(doc, READ);
  doc.getMovableList("order").push("t1"); // a merge listed it twice
  expect(removeTile(doc, "t1")).toEqual(tile("t1"));
  expect(removeTile(doc, "ed")).toEqual(tile("ed", { kind: "editor" }));
  expect(readCore(doc)).toEqual({ frames: READ.frames, tiles: [tile("t2"), tile("t3")], tileNames: {}, editorTabs: {}, frameOf: { t2: "f2", t3: "f2" } });
  expect(doc.getMovableList("order").toArray()).toEqual(["t2", "t3"]);
  expect(removeTile(doc, "t1")).toBeNull();
  expect(removeTile(doc, "gone")).toBeNull();
});

test("a tile is opened on its own, last, in its frame and with its name; one already there, or malformed, is not", () => {
  const doc = new LoroDoc();
  expect(addTile(doc, tile("t1"), { frame: "f1", name: "api" })).toBe(true);
  expect(readCore(doc)).toEqual({ frames: [], tiles: [tile("t1")], tileNames: { t1: "api" }, editorTabs: {}, frameOf: { t1: "f1" } });
  writeCore(doc, READ);
  expect(addTile(doc, tile("t9", { task: "fix it" }))).toBe(true);
  expect(addTile(doc, tile("t0"))).toBe(true);
  expect(readCore(doc)).toEqual({ ...READ, tiles: [...READ.tiles, tile("t9", { task: "fix it" }), tile("t0")] });
  expect(addTile(doc, tile("t2", { label: "again" }))).toBe(false);
  expect(() => addTile(doc, { id: "t8" } as never)).toThrow(TypeError);
  expect(() => addTile(doc, tile("t8", { frame: "f1" }))).toThrow(TypeError);
  expect(readCore(doc)?.tiles.map((t) => t.id)).toEqual(["t1", "t2", "t3", "ed", "t9", "t0"]);
});

const at = (x: number, y = 0) => ({ x, y });
const canvas = (positions: Fields, sizes: Fields = {}) => ({ v: 1, data: { positions, sizes } });

test("a view written from an older reading changes what its writer changed, tile by tile, and keeps what others changed since", () => {
  const doc = new LoroDoc();
  const read = canvas({ t1: at(0), t2: at(100), t3: at(200) });
  writeView(doc, "canvas", read);
  // Another writer, since: moves t2 and places t4.
  writeView(doc, "canvas", canvas({ t1: at(0), t2: at(150, 50), t3: at(200), t4: at(300) }));
  // The window, still on what it read: moves t1, forgets t3 (closed) and sizes t1.
  writeView(doc, "canvas", canvas({ t1: at(10, 10), t2: at(100) }, { t1: { width: 500, height: 300 } }), read);
  expect(readView(doc, "canvas")).toEqual(canvas({ t1: at(10, 10), t2: at(150, 50), t4: at(300) }, { t1: { width: 500, height: 300 } }));
  // A writer that read nothing keeps what is there.
  writeView(doc, "canvas", canvas({ t5: at(400) }), null);
  expect(Object.keys((readView(doc, "canvas")!.data as { positions: Fields }).positions).sort()).toEqual(["t1", "t2", "t4", "t5"]);
});

test("a view of another version, or whose data is not fields, is written as given", () => {
  const doc = new LoroDoc();
  const read = canvas({ t1: at(0) });
  writeView(doc, "canvas", read);
  writeView(doc, "canvas", canvas({ t1: at(0), t2: at(100) }));
  writeView(doc, "canvas", { v: 2, data: { positions: {} } }, read);
  expect(readView(doc, "canvas")).toEqual({ v: 2, data: { positions: {} } });
  // A writer whose reading was of another version removed nothing from this one.
  writeView(doc, "canvas", { v: 2, data: { positions: { t1: at(0), t2: at(100) } } });
  writeView(doc, "canvas", { v: 2, data: { positions: { t1: at(5) } } }, canvas({ t1: at(0), t2: at(100) }));
  expect(readView(doc, "canvas")).toEqual({ v: 2, data: { positions: { t1: at(5), t2: at(100) } } });
  writeView(doc, "list", { v: 1, data: ["a", "b"] });
  writeView(doc, "list", { v: 1, data: ["c"] }, { v: 1, data: ["a"] });
  expect(readView(doc, "list")).toEqual({ v: 1, data: ["c"] });
});

const note = (id: string, text: string, fields: Fields = {}) => ({ id, kind: "note", x: 0, y: 0, w: 200, h: 160, color: "yellow", text, ...fields }) as BoardObject;
const arrow = (id: string, from: string, to: string) => ({ id, kind: "arrow", from: { id: from, side: "right" }, to: { id: to, side: "left" }, label: "" }) as BoardObject;

test("a board written from an older reading changes what its writer changed, field by field, and keeps what others changed since", () => {
  const doc = new LoroDoc();
  writeObjects(doc, [note("n1", "ship R15"), note("n2", "tests"), arrow("a1", "n1", "n2")]);
  const read = readObjects(doc);
  // Another writer, since: retypes n1, deletes n2 and adds n3.
  writeObjects(doc, [note("n1", "ship R5"), arrow("a1", "n1", "n2"), note("n3", "docs")]);
  // The window, still on what it read: moves n1, recolours n2 and deletes the arrow. n2, deleted
  // since, stays deleted.
  writeObjects(doc, [note("n1", "ship R15", { x: 40 }), note("n2", "tests", { color: "pink" })], read);
  expect(readObjects(doc)).toEqual([note("n1", "ship R5", { x: 40 }), note("n3", "docs")]);
});
