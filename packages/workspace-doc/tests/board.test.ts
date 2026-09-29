// Board objects in the workspace document: what is written reads back, edits two documents make
// at once merge (a note's text by character, a checklist item by item), and input is checked.
import { expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt";
import { readObjects, writeObjects } from "../src/objects.ts";
import type { BoardObject, ChecklistItem } from "../src/shapes.ts";
import { mulberry32 } from "./random.ts";

type Fields = Record<string, unknown>;
const note = (id: string, text: string, fields: Fields = {}) => ({ id, kind: "note", x: 0, y: 0, w: 200, h: 160, color: "yellow", text, ...fields }) as BoardObject;
const checklist = (id: string, text: string, items: ChecklistItem[], fields: Fields = {}) =>
  ({ id, kind: "checklist", x: 300, y: 0, w: 240, h: 200, text, items, ...fields }) as BoardObject;
const item = (id: string, text: string, done = false): ChecklistItem => ({ id, text, done });
const arrow = (id: string, from: string, to: string, label = "") =>
  ({ id, kind: "arrow", from: { id: from, side: "right" }, to: { id: to, side: "left" }, label }) as BoardObject;
const byId = (board: BoardObject[]) => [...board].sort((a, b) => (a.id < b.id ? -1 : 1));

const BOARD: BoardObject[] = [
  note("n1", "ship R15", { frame: "f1", z: 2 }),
  // A field the document does not read is kept as given.
  { id: "t1", kind: "text", x: 0, y: 200, w: 300, h: 40, text: "Sprint board", fontSize: 24 } as BoardObject,
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
  writeObjects(doc, BOARD);
  doc.commit();
  expect(readObjects(doc)).toEqual(byId(BOARD));

  const frontiers = doc.oplogFrontiers();
  writeObjects(doc, structuredClone(BOARD));
  doc.commit();
  expect(doc.oplogFrontiers()).toEqual(frontiers);
});

test("an edited board reads back as edited: objects added, moved, retyped and removed, items added, ticked, reordered and removed", () => {
  const doc = new LoroDoc();
  writeObjects(doc, BOARD);
  const edited = [
    note("n1", "ship R15 today", { frame: "f2", z: 3, x: 40, color: "pink" }),
    note("n2", "new"),
    checklist("c1", "tomorrow", [item("i3", "first"), item("i2", "review", true)]),
    arrow("a1", "n2", "tile-1", "see"),
  ];
  writeObjects(doc, edited);
  expect(readObjects(doc)).toEqual(byId(edited));
});

test("two documents editing one note and one checklist at once keep both sides' edits", () => {
  const a = new LoroDoc();
  writeObjects(a, BOARD);
  const b = new LoroDoc();
  b.import(a.export({ mode: "snapshot" }));

  // At once: a types at the end of the note and ticks "review"; b types at its start, reorders
  // the checklist and retypes "write tests".
  writeObjects(a, [note("n1", "ship R15 today", { frame: "f1", z: 2 }), BOARD[1]!, checklist("c1", "today", [item("i1", "write tests", true), item("i2", "review", true)]), BOARD[3]!]);
  writeObjects(b, [note("n1", "Please ship R15", { frame: "f1", z: 2 }), BOARD[1]!, checklist("c1", "today", [item("i2", "review"), item("i1", "write more tests", true)]), BOARD[3]!]);

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
  writeObjects(a, BOARD);
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
    writeObjects(doc, board);
  };

  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(a, "a");
    for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(b, "b");
    if (random() < 0.6) sync(a, b);
  }
  sync(a, b);
  expect(readObjects(b)).toEqual(readObjects(a));
});

test("input from outside is checked: an object or item without what its kind needs is dropped, and what is not a board is refused", () => {
  const doc = new LoroDoc();
  writeObjects(doc, [
    note("n1", "kept"),
    note("n1", "a second n1"),
    { id: "n2", kind: "note", x: 0, y: 0, w: 1, h: 1 }, // no text
    { ...note("n3", "no width"), w: "wide" },
    { ...note("s1", "not a kind"), kind: "sticker" },
    { ...arrow("a1", "n1", "n2"), from: { id: "n1", side: "middle" } },
    checklist("c1", "list", [item("i1", "ok"), { id: "i2", text: 3, done: false } as never, item("i1", "a second i1")]),
    { ...note("", "no id") },
    42,
    null,
  ]);
  expect(readObjects(doc)).toEqual([checklist("c1", "list", [item("i1", "ok")]), note("n1", "kept")]);

  expect(() => writeObjects(doc, { n1: note("n1", "not a list") })).toThrow(TypeError);
  expect(readObjects(doc).map((o) => o.id)).toEqual(["c1", "n1"]);
});

test("a record another writer left without what its kind needs is skipped when read", () => {
  const doc = new LoroDoc();
  writeObjects(doc, [note("n1", "kept")]);
  doc.getMap("objects").ensureMergeableMap("n2").set("kind", "note"); // no box, no text
  expect(readObjects(doc)).toEqual([note("n1", "kept")]);
});
