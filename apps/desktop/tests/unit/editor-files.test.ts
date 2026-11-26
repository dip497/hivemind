// The Code tile's open files (editor-files.ts): each file keeps its own editor state across tab
// switches, a CRLF file is saved with CRLF and reads as saved when unchanged, and a change on disk
// is applied as the smallest edit to a clean file and never over unsaved edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState, StateEffect, type Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { OpenFiles, type FileView } from "../../src/renderer/src/editor-files";

const scrolledTo = StateEffect.define<number>();
/** One editor showing one file at a time, as the Code tile's is: its state, and how far it is scrolled. */
function editor() {
  const view = {
    state: EditorState.create(),
    top: 0,
    setState(s: EditorState) { view.state = s; view.top = 0; },
    dispatch(tr: Transaction) {
      view.state = tr.state;
      for (const e of tr.effects) if (e.is(scrolledTo)) view.top = e.value;
    },
    scrollSnapshot: () => scrolledTo.of(view.top),
  };
  return view satisfies FileView;
}
const type = (view: ReturnType<typeof editor>, at: number, text: string) =>
  view.dispatch(view.state.update({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } }));
const undoIn = (view: ReturnType<typeof editor>) => undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });

test("a file's edits, cursor, scroll and undo survive switching to another file and back", () => {
  const files = new OpenFiles();
  const view = editor();
  files.open("a.ts", "const a = 1;\n", [history()]);
  files.open("b.ts", "const b = 2;\n", [history()]);
  files.show("a.ts", view);
  type(view, 0, "// edited\n");
  view.top = 340;

  files.show("b.ts", view);
  assert.equal(view.state.doc.toString(), "const b = 2;\n");
  type(view, 0, "x");
  files.show("a.ts", view);

  assert.equal(view.state.doc.toString(), "// edited\nconst a = 1;\n");
  assert.equal(view.state.selection.main.head, 10);
  assert.equal(view.top, 340);
  assert.ok(files.unsaved("a.ts", view));
  assert.ok(undoIn(view), "undo reaches the edit made before the switch");
  assert.equal(view.state.doc.toString(), "const a = 1;\n");
  assert.ok(!files.unsaved("a.ts", view), "undone back to what is on disk is saved again");
  assert.ok(files.unsaved("b.ts", view), "the other file kept its edit too");
});

test("a CRLF file is not unsaved when opened or when an edit is undone, and saves with CRLF on every line", () => {
  const files = new OpenFiles();
  const view = editor();
  files.open("win.txt", "one\r\ntwo\r\n", [history()]);
  files.show("win.txt", view);
  assert.ok(!files.unsaved("win.txt", view));
  type(view, 3, "!");
  assert.ok(files.unsaved("win.txt", view));
  assert.equal(files.toSave("win.txt", view)?.text, "one!\r\ntwo\r\n");
  undoIn(view);
  assert.ok(!files.unsaved("win.txt", view));
});

test("an agent's write to a clean file is applied as the smallest edit: the cursor stays and undo goes back one edit", () => {
  const files = new OpenFiles();
  const view = editor();
  files.open("cart.ts", "line 1\nline 2\nline 3\n", [history()]);
  files.show("cart.ts", view);
  view.dispatch(view.state.update({ selection: EditorSelection.cursor(18) }));

  assert.equal(files.fromDisk("cart.ts", "line 1\nline TWO\nline 3\n", view), "applied");
  assert.equal(view.state.doc.toString(), "line 1\nline TWO\nline 3\n");
  assert.equal(view.state.selection.main.head, 20, "the cursor in line 3 stays in line 3");
  assert.ok(!files.unsaved("cart.ts", view));
  undoIn(view);
  assert.equal(view.state.doc.toString(), "line 1\nline 2\nline 3\n", "one undo takes back only the agent's change");
});

test("a change on disk never overwrites unsaved edits; Reload applies it over them", () => {
  const files = new OpenFiles();
  const view = editor();
  files.open("tax.ts", "rate = 1\n", [history()]);
  files.show("tax.ts", view);
  type(view, 0, "// mine\n");

  assert.equal(files.fromDisk("tax.ts", "rate = 2\n", view), "conflict");
  assert.equal(view.state.doc.toString(), "// mine\nrate = 1\n");
  assert.equal(files.fromDisk("tax.ts", "rate = 2\n", view, true), "applied");
  assert.equal(view.state.doc.toString(), "rate = 2\n");
  assert.ok(!files.unsaved("tax.ts", view));
});

test("our own save seen on disk after more typing is the same, not a conflict; Reload still goes back to it", () => {
  const files = new OpenFiles();
  const view = editor();
  files.open("tax.ts", "rate = 1\r\n", [history()]);
  files.show("tax.ts", view);
  type(view, 0, "// saved\n");
  const out = files.toSave("tax.ts", view)!;
  files.markSaved("tax.ts", out.doc);
  type(view, 0, "// typed after\n");

  assert.equal(files.fromDisk("tax.ts", out.text, view), "same");
  assert.ok(files.unsaved("tax.ts", view), "the edits after the save are still unsaved");
  assert.equal(files.fromDisk("tax.ts", out.text, view, true), "applied");
  assert.equal(view.state.doc.toString(), "// saved\nrate = 1\n");
});
