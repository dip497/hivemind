// A write from an older reading (src/rebase.ts through writeCore): a window saves its whole core
// layout, made from what it last read. Another writer changed the document since; the window's
// write keeps its own changes and leaves everyone else's as they are.
import { expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt";
import { readCore, removeTile, writeCore, writeTileName } from "../src/core.ts";

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
