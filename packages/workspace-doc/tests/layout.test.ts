// The workspace document as the layout's home: what is written reads back, edits two documents
// make at once merge instead of one overwriting the other, and input from outside is checked.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc } from "loro-crdt";
import { readCore, writeCore } from "../src/core.ts";
import { readView, writeView } from "../src/views.ts";

type Fields = Record<string, unknown>;
const frame = (id: string, fields: Fields = {}) => ({ id, x: 0, y: 0, w: 400, h: 300, title: id, color: "#888", z: 1, ...fields });
const tile = (id: string, fields: Fields = {}) => ({ id, kind: "shell", label: id, cmd: "/bin/bash", args: ["-il"], ...fields });

const LAYOUT = {
  frames: [
    frame("repo", { workspacePath: "/work/api" }),
    frame("wt", { parentFrameId: "repo", branch: "fix", worktreePath: "/work/api-fix" }),
    frame("loose"),
  ],
  tiles: [tile("t1"), tile("t2", { kind: "claude", pinned: true, pinAnchor: { sx: 10, sy: 20 } }), tile("ed", { kind: "editor" })],
  tileNames: { t1: "api shell" },
  editorTabs: { ed: ["src/a.ts", "src/b.ts"] },
  frameOf: { t1: "repo", t2: "wt" },
};

/** Give each document everything the other has. */
function sync(a: LoroDoc, b: LoroDoc): void {
  const fromA = a.export({ mode: "update" });
  const fromB = b.export({ mode: "update" });
  a.import(fromB);
  b.import(fromA);
}

function copyOf(doc: LoroDoc): LoroDoc {
  const copy = new LoroDoc();
  copy.import(doc.export({ mode: "snapshot" }));
  return copy;
}

test("a core layout reads back as written, and a document never written has none", () => {
  const doc = new LoroDoc();
  expect(readCore(doc)).toBeNull();
  writeCore(doc, LAYOUT);
  expect(readCore(doc)).toEqual(LAYOUT);
});

test("an edited layout reads back as edited: tiles opened, closed and moved, frames added, removed and re-nested", () => {
  const doc = new LoroDoc();
  writeCore(doc, LAYOUT);
  const edited = {
    frames: [frame("loose", { title: "renamed" }), frame("sub", { parentFrameId: "loose" }), frame("wt", { branch: "fix", worktreePath: "/work/api-fix" })],
    tiles: [tile("t3"), tile("t2", { kind: "claude", pinned: false }), tile("t1")],
    tileNames: { t1: "renamed shell", t3: "new" },
    editorTabs: {},
    frameOf: { t3: "sub", t2: "loose" },
  };
  writeCore(doc, edited);
  expect(readCore(doc)).toEqual(edited);
});

test("a frame whose parent is removed stays, at the top level, and a parent cycle breaks there too", () => {
  const doc = new LoroDoc();
  writeCore(doc, { frames: [frame("repo"), frame("wt", { parentFrameId: "repo" })], tiles: [] });
  writeCore(doc, { frames: [frame("wt", { parentFrameId: "repo" })], tiles: [] });
  expect(readCore(doc)!.frames).toEqual([frame("wt")]);

  writeCore(doc, { frames: [frame("a", { parentFrameId: "b" }), frame("b", { parentFrameId: "a" })], tiles: [] });
  expect(readCore(doc)!.frames).toEqual([frame("a"), frame("b", { parentFrameId: "a" })]);
});

test("edits two documents make at once to different tiles and fields all survive the merge", () => {
  const a = new LoroDoc();
  writeCore(a, LAYOUT);
  const b = copyOf(a);

  // At once: a renames t1 and moves t2 into another frame; b relabels t2 and gives t1 a url.
  // Each also lays out a different tile on the canvas, which neither had laid out yet.
  writeCore(a, { ...LAYOUT, tileNames: { t1: "from a" }, frameOf: { t1: "repo", t2: "loose" } });
  writeView(a, "canvas", { v: 1, data: { positions: { t1: { x: 1, y: 1 } } } });
  const tilesFromB = [tile("t1", { url: "http://b" }), { ...LAYOUT.tiles[1], label: "from b" }, LAYOUT.tiles[2]];
  writeCore(b, { ...LAYOUT, tiles: tilesFromB });
  writeView(b, "canvas", { v: 1, data: { positions: { t2: { x: 2, y: 2 } } } });

  sync(a, b);
  const merged = { ...LAYOUT, tiles: tilesFromB, tileNames: { t1: "from a" }, frameOf: { t1: "repo", t2: "loose" } };
  expect(readCore(a)).toEqual(merged);
  expect(readCore(b)).toEqual(merged);
  const canvas = { v: 1, data: { positions: { t1: { x: 1, y: 1 }, t2: { x: 2, y: 2 } } } };
  expect(readView(a, "canvas")).toEqual(canvas);
  expect(readView(b, "canvas")).toEqual(canvas);
});

test("random edits made at once on two documents converge on one layout", () => {
  const random = mulberry32(20260929);
  const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(random() * xs.length)];
  const a = new LoroDoc();
  writeCore(a, LAYOUT);
  const b = copyOf(a);
  let n = 0;

  const edit = (doc: LoroDoc, side: string): void => {
    n++;
    const layout = structuredClone(readCore(doc)) as { frames: Fields[]; tiles: Fields[]; tileNames: Record<string, string>; frameOf: Record<string, string> };
    const positions = structuredClone((readView(doc, "canvas")?.data as { positions?: Record<string, unknown> } | undefined)?.positions ?? {});
    const someTile = pick(layout.tiles);
    const someFrame = pick(layout.frames);
    switch (Math.floor(random() * 9)) {
      case 0: layout.tiles.push(tile(`${side}${n}`)); break;
      case 1: if (someTile) layout.tiles = layout.tiles.filter((t) => t !== someTile); break;
      case 2: if (someTile) layout.tileNames[someTile.id as string] = `${side}${n}`; break;
      case 3: if (someTile) someTile.label = `${side}${n}`; break;
      case 4: if (someTile) { layout.tiles = layout.tiles.filter((t) => t !== someTile); layout.tiles.splice(Math.floor(random() * (layout.tiles.length + 1)), 0, someTile); } break;
      case 5: layout.frames.push(frame(`${side}f${n}`, someFrame ? { parentFrameId: someFrame.id } : {})); break;
      case 6: if (someFrame) layout.frames = layout.frames.filter((f) => f !== someFrame); break;
      case 7: if (someTile && someFrame) layout.frameOf[someTile.id as string] = someFrame.id as string; break;
      case 8: if (someTile) positions[someTile.id as string] = { x: n, y: -n }; break;
    }
    writeCore(doc, layout);
    writeView(doc, "canvas", { v: 1, data: { positions } });
  };

  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(a, "a");
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(b, "b");
    if (random() < 0.6) sync(a, b);
  }
  sync(a, b);
  expect(readCore(b)).toEqual(readCore(a)!);
  expect(readView(b, "canvas")).toEqual(readView(a, "canvas")!);
});

test("a document another writer left with a tile missing from the order, or listed twice, reads each tile once", () => {
  const doc = new LoroDoc();
  writeCore(doc, LAYOUT);
  const order = doc.getMovableList("order");
  order.delete(0, 1); // t1 is no longer in the order
  order.push("t2"); // t2 is in it twice
  order.push("gone"); // a tile the document does not have
  expect(readCore(doc)!.tiles.map((t) => t.id)).toEqual(["t2", "ed", "t1"]);
});

test("input from outside is checked: malformed entries are dropped, and what cannot be a layout is refused", () => {
  const doc = new LoroDoc();
  writeCore(doc, {
    frames: [frame("f1"), { title: "no id" }, frame("f1", { title: "again" }), 5],
    tiles: [tile("t1"), { id: "t2" }, tile("t1", { label: "again" })],
    tileNames: { t1: 7 },
  });
  expect(readCore(doc)).toEqual({ frames: [frame("f1")], tiles: [tile("t1")], tileNames: {}, editorTabs: {}, frameOf: {} });

  expect(() => writeCore(doc, [])).toThrow(TypeError);
  expect(() => writeCore(doc, { frames: [], tiles: [tile("t3", { name: "set on the tile" })] })).toThrow(TypeError);
  expect(() => writeView(doc, "", { v: 1, data: {} })).toThrow(TypeError);
  expect(() => writeView(doc, "canvas", { data: {} } as never)).toThrow(TypeError);
  expect(readCore(doc)!.tiles.map((t) => t.id)).toEqual(["t1"]);
  expect(readView(doc, "canvas")).toBeNull();
});

test("a view layout reads back as written, whatever its data", () => {
  const doc = new LoroDoc();
  const layouts = {
    canvas: { v: 1, data: { positions: { t1: { x: 1, y: 2 } }, sizes: {}, viewport: { x: 0, y: 0, zoom: 1.5 } } },
    windows: { v: 1, data: { minimized: ["t1"], activeTabId: null } },
    deep: { v: 3, data: { a: { b: { c: [1, { d: 2 }] } } } },
    list: { v: 1, data: [1, 2] },
    none: { v: 1, data: null },
  };
  for (const [id, layout] of Object.entries(layouts)) writeView(doc, id, layout);
  for (const [id, layout] of Object.entries(layouts)) expect(readView(doc, id)).toEqual(layout);
  expect(readView(doc, "missing")).toBeNull();

  // As JSON keeps it: a field left undefined is absent, not null.
  writeView(doc, "json", { v: 1, data: { a: { b: { c: 1, d: undefined } } } });
  expect(readView(doc, "json")).toEqual({ v: 1, data: { a: { b: { c: 1 } } } });

  writeView(doc, "canvas", { v: 1, data: { positions: {} } });
  expect(readView(doc, "canvas")).toEqual({ v: 1, data: { positions: {} } });
});

test("a document made by another copy of loro-crdt is read and written the same", () => {
  // Two packages resolving two installs load two copies: a map from one is no instance of the
  // other's classes, and a reader that relied on instanceof saw an empty document.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "loro-copy-"));
  fs.cpSync(path.join(path.dirname(require.resolve("loro-crdt/package.json")), "nodejs"), copy, { recursive: true });
  const { LoroDoc: OtherLoroDoc } = require(path.join(copy, "index.js")) as { LoroDoc: typeof LoroDoc };
  const doc = new OtherLoroDoc();
  writeCore(doc, LAYOUT);
  writeView(doc, "canvas", { v: 1, data: { positions: { t1: { x: 1, y: 2 } } } });
  expect(readCore(doc)).toEqual(LAYOUT);
  expect(readView(doc, "canvas")).toEqual({ v: 1, data: { positions: { t1: { x: 1, y: 2 } } } });
  fs.rmSync(copy, { recursive: true, force: true });
});

/** A small seeded generator, so a failing run can be replayed. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
