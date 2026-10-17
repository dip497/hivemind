// Board objects in the workspace document: what is written reads back, edits two documents make
// at once merge (a note's text by character, a checklist item by item), and input is checked.
import { expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt";
import { editObjects, readObjects } from "../src/objects.ts";
import { boardEdit } from "../src/board-edit.ts";
import type { BoardObject, ChecklistItem } from "../src/shapes.ts";
import { mulberry32 } from "./random.ts";

type Fields = Record<string, unknown>;
/** A sticky note: the app's `note` widget on the board, its colour an option. */
const note = (id: string, text: string, fields: Fields = {}) => {
  const { color = "yellow", ...rest } = fields;
  return { id, kind: "widget", widget: "note", placement: "board", x: 0, y: 0, w: 200, h: 160, text, options: { color }, ...rest } as BoardObject;
};
const checklist = (id: string, text: string, items: ChecklistItem[], fields: Fields = {}) =>
  ({ id, kind: "widget", widget: "checklist", placement: "board", x: 300, y: 0, w: 240, h: 200, text, items, ...fields }) as BoardObject;
const item = (id: string, text: string, done = false): ChecklistItem => ({ id, text, done });
const arrow = (id: string, from: string, to: string, label = "") =>
  ({ id, kind: "arrow", from: { id: from, side: "right" }, to: { id: to, side: "left" }, label }) as BoardObject;
/** Make `doc`'s board `next`, as a writer that read it just now: the edit from what it holds. */
const writeBoard = (doc: LoroDoc, next: readonly unknown[]) => editObjects(doc, boardEdit(readObjects(doc), next as BoardObject[]));
const byId = (board: BoardObject[]) => [...board].sort((a, b) => (a.id < b.id ? -1 : 1));

const BOARD: BoardObject[] = [
  note("n1", "ship R15", { frame: "f1", z: 2 }),
  // A field the document does not read is kept as given.
  { id: "t1", kind: "widget", widget: "text", placement: "board", x: 0, y: 200, w: 300, h: 40, text: "Sprint board", fontSize: 24 } as BoardObject,
  checklist("c1", "today", [item("i1", "write tests", true), item("i2", "review")]),
  arrow("a1", "n1", "tile-1", "about"),
];

/** Give each document everything the other has. */
function sync(a: LoroDoc, b: LoroDoc): void {
  const fromA = a.export({ mode: "update" });
  const fromB = b.export({ mode: "update" });
  a.import(fromB);
  b.import(fromA);
}

test("a board reads back as written, a document never written has none, and writing it again records nothing", () => {
  const doc = new LoroDoc();
  expect(readObjects(doc)).toEqual([]);
  writeBoard(doc, BOARD);
  doc.commit();
  expect(readObjects(doc)).toEqual(byId(BOARD));

  const frontiers = doc.oplogFrontiers();
  writeBoard(doc, structuredClone(BOARD));
  doc.commit();
  expect(doc.oplogFrontiers()).toEqual(frontiers);
});

test("an edited board reads back as edited: objects added, moved, retyped and removed, items added, ticked, reordered and removed", () => {
  const doc = new LoroDoc();
  writeBoard(doc, BOARD);
  const edited = [
    note("n1", "ship R15 today", { frame: "f2", z: 3, x: 40, color: "pink" }),
    note("n2", "new"),
    checklist("c1", "tomorrow", [item("i3", "first"), item("i2", "review", true)]),
    arrow("a1", "n2", "tile-1", "see"),
  ];
  writeBoard(doc, edited);
  expect(readObjects(doc)).toEqual(byId(edited));
});

test("two documents editing one note and one checklist at once keep both sides' edits", () => {
  const a = new LoroDoc();
  writeBoard(a, BOARD);
  const b = new LoroDoc();
  b.import(a.export({ mode: "snapshot" }));

  // At once: a types at the end of the note and ticks "review"; b types at its start, reorders
  // the checklist and retypes "write tests".
  writeBoard(a, [note("n1", "ship R15 today", { frame: "f1", z: 2 }), BOARD[1]!, checklist("c1", "today", [item("i1", "write tests", true), item("i2", "review", true)]), BOARD[3]!]);
  writeBoard(b, [note("n1", "Please ship R15", { frame: "f1", z: 2 }), BOARD[1]!, checklist("c1", "today", [item("i2", "review"), item("i1", "write more tests", true)]), BOARD[3]!]);

  sync(a, b);
  const merged = byId([
    note("n1", "Please ship R15 today", { frame: "f1", z: 2 }),
    BOARD[1]!,
    checklist("c1", "today", [item("i2", "review", true), item("i1", "write more tests", true)]),
    BOARD[3]!,
  ]);
  expect(readObjects(a)).toEqual(merged);
  expect(readObjects(b)).toEqual(merged);
});

test("random edits made at once on two documents converge on one board", () => {
  const random = mulberry32(20260929);
  const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(random() * xs.length)];
  const a = new LoroDoc();
  writeBoard(a, BOARD);
  const b = new LoroDoc();
  b.import(a.export({ mode: "snapshot" }));
  let n = 0;

  const edit = (doc: LoroDoc, side: string): void => {
    n++;
    const board = structuredClone(readObjects(doc)) as Array<BoardObject & Fields>;
    const some = pick(board);
    const list = pick(board.filter((o) => o.kind === "checklist")) as (BoardObject & { items: ChecklistItem[] }) | undefined;
    switch (Math.floor(random() * 8)) {
      case 0: board.push(random() < 0.5 ? note(`${side}${n}`, `${side}${n}`) : checklist(`${side}${n}`, "", [item(`${side}i${n}`, "x")])); break;
      case 1: if (some) board.splice(board.indexOf(some), 1); break;
      case 2: if (some && "text" in some) { const at = Math.floor(random() * (some.text.length + 1)); some.text = `${some.text.slice(0, at)}${side}${n}${some.text.slice(at)}`; } break;
      case 3: if (some && "x" in some) { some.x = n; some.y = -n; } break;
      case 4: { const line = list && pick(list.items); if (line) line.done = !line.done; break; }
      case 5: if (list) list.items.splice(Math.floor(random() * (list.items.length + 1)), 0, item(`${side}i${n}`, `${side}${n}`)); break;
      case 6: { const line = list && pick(list.items); if (list && line) { list.items.splice(list.items.indexOf(line), 1); list.items.splice(Math.floor(random() * (list.items.length + 1)), 0, line); } break; }
      case 7: { const line = list && pick(list.items); if (list && line) list.items.splice(list.items.indexOf(line), 1); break; }
    }
    writeBoard(doc, board);
  };

  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(a, "a");
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(b, "b");
    if (random() < 0.6) sync(a, b);
  }
  sync(a, b);
  expect(readObjects(b)).toEqual(readObjects(a));
});

test("input from outside is checked: an object or item without what its kind needs, or under an id not its own, is dropped, and what is not an edit is refused", () => {
  const doc = new LoroDoc();
  editObjects(doc, { objects: {
    n1: note("n1", "kept"),
    n4: note("n1", "under another id"),
    n2: { id: "n2", kind: "widget", widget: "note", placement: "board", text: "on the board, no box" },
    n3: { ...note("n3", "no width"), w: "wide" },
    s1: { ...note("s1", "not a kind"), kind: "sticker" },
    a1: { ...arrow("a1", "n1", "n2"), from: { id: "n1", side: "middle" } },
    c1: checklist("c1", "list", [item("i1", "ok"), { id: "i2", text: 3, done: false } as never, item("i1", "a second i1")]),
    "": { ...note("", "no id") },
    x: 42,
  } });
  expect(readObjects(doc)).toEqual([checklist("c1", "list", [item("i1", "ok")]), note("n1", "kept")]);

  for (const notAnEdit of [[note("n1", "a list")], { objects: [note("n1", "a list")] }, { objects: {}, base: 3 }, null]) {
    expect(() => editObjects(doc, notAnEdit)).toThrow(TypeError);
  }
  expect(readObjects(doc).map((o) => o.id)).toEqual(["c1", "n1"]);
});

test("a record another writer left without what its kind needs is skipped when read", () => {
  const doc = new LoroDoc();
  writeBoard(doc, [note("n1", "kept")]);
  doc.getMap("objects").ensureMergeableMap("n2").set("kind", "note"); // no box, no text
  expect(readObjects(doc)).toEqual([note("n1", "kept")]);
});

test("a widget keeps its state and options; too big a state, options that are not a map, and a widget without its package are not kept", () => {
  const doc = new LoroDoc();
  const base = { kind: "widget", z: 1, widget: "meter" };
  writeBoard(doc, [
    { id: "w1", ...base, state: { resets: 1 }, options: { minutes: 25 } },
    { id: "w4", ...base, options: "not a map" },
    { id: "w2", ...base, state: { big: "x".repeat(20_000) } },
    { id: "w3", ...base, widget: "" },
  ]);
  doc.commit();
  expect(readObjects(doc)).toEqual([{ id: "w1", ...base, state: { resets: 1 }, options: { minutes: 25 } }, { id: "w2", ...base }, { id: "w4", ...base }] as BoardObject[]);
});

test("a widget on the board has a box, and what people write in it merges as a note's does: text by character, lines one by one", () => {
  const box = { kind: "widget", widget: "hivemind/note", placement: "board", x: 0, y: 0, w: 200, h: 160 };
  const a = new LoroDoc();
  writeBoard(a, [{ id: "n", ...box, text: "ship it", items: [item("i1", "tests")] }]);
  a.commit();
  const b = new LoroDoc();
  b.import(a.export({ mode: "snapshot" }));
  writeBoard(a, [{ id: "n", ...box, text: "ship it today", items: [item("i1", "tests", true)] }]);
  writeBoard(b, [{ id: "n", ...box, text: "please ship it", items: [item("i1", "tests"), item("i2", "docs")] }]);
  a.commit(); b.commit();
  sync(a, b);
  expect(readObjects(a)).toEqual(readObjects(b));
  expect(readObjects(a)).toEqual([{ id: "n", ...box, text: "please ship it today", items: [item("i1", "tests", true), item("i2", "docs")] } as BoardObject]);
  // On the board without its box, it is not kept.
  const c = new LoroDoc();
  writeBoard(c, [{ id: "x", kind: "widget", widget: "hivemind/note", placement: "board" }]);
  expect(readObjects(c)).toEqual([]);
});

test("a note, a checklist and a text label an older version wrote are read as the widgets they are now, and written back as such", () => {
  const doc = new LoroDoc();
  writeBoard(doc, [
    { id: "n1", kind: "note", x: 0, y: 0, w: 200, h: 160, color: "pink", text: "ship it", frame: "f1", z: 2 },
    { id: "c1", kind: "checklist", x: 300, y: 0, w: 240, h: 200, text: "today", items: [item("i1", "tests", true)] },
    { id: "t1", kind: "text", x: 0, y: 200, w: 300, h: 40, text: "Sprint" },
    arrow("a1", "n1", "c1"),
  ]);
  doc.commit();
  const board = [
    arrow("a1", "n1", "c1"),
    { id: "c1", kind: "widget", widget: "checklist", placement: "board", x: 300, y: 0, w: 240, h: 200, text: "today", items: [item("i1", "tests", true)] },
    { id: "n1", kind: "widget", widget: "note", placement: "board", x: 0, y: 0, w: 200, h: 160, text: "ship it", frame: "f1", z: 2, options: { color: "pink" } },
    { id: "t1", kind: "widget", widget: "text", placement: "board", x: 0, y: 200, w: 300, h: 40, text: "Sprint" },
  ] as BoardObject[];
  expect(readObjects(doc)).toEqual(board);
  // Written back, it is the widget in the document too, and reads the same.
  writeBoard(doc, readObjects(doc));
  doc.commit();
  expect((doc.getMap("objects").toJSON() as Record<string, { kind: string }>).n1!.kind).toBe("widget");
  expect(readObjects(doc)).toEqual(board);
});
