// Comments on code in an open file (code/code-comments.ts): they move with each edit, stay on lines
// edited inside them, are found again by their text when a change from disk rewrites around them,
// and are kept, outdated, when their lines are deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { anchorAt, type CodeComment } from "@hivemind/core/review-shape";
import { OpenFiles } from "../../src/renderer/src/editor-files";
import { codeCommentsField, movedAnchors, setCodeComments } from "../../src/renderer/src/code/code-comments";

const text = ["import x from 'x';", "", "function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i;", "  return sum;", "}", "", "export default total;"].join("\n");
const comment: CodeComment = { id: "c1", file: "a.ts", ...anchorAt(text.split("\n"), 5, 6), body: "use reduce?", author: "you", at: "2026-11-25T00:00:00Z" };

function opened(): EditorState {
  const state = EditorState.create({ doc: text, extensions: [codeCommentsField] });
  return state.update({ effects: setCodeComments.of([comment]) }).state;
}
/** The 1-based lines the comment covers now, or "outdated". */
function where(state: EditorState): [number, number] | "outdated" {
  const [p] = state.field(codeCommentsField);
  if (!p) throw new Error("the comment was dropped");
  return p.outdated ? "outdated" : [state.doc.lineAt(p.from).number, state.doc.lineAt(p.to).number];
}
const lineStart = (state: EditorState, n: number) => state.doc.line(n).from;

test("lines inserted above move it down with them", () => {
  const state = opened();
  const next = state.update({ changes: { from: 0, insert: "// one\n// two\n" } }).state;
  assert.deepEqual(where(next), [7, 8]);
  assert.deepEqual(movedAnchors(next).map((m) => [m.to.startLine, m.to.endLine]), [[7, 8]]);
});

test("an edit inside its lines keeps it on them, a line added there included", () => {
  const state = opened();
  const at = lineStart(state, 5) + "  for (const ".length;
  const next = state.update({ changes: [{ from: at, to: at + 1, insert: "item" }, { from: lineStart(state, 6), insert: "  // sum is the total\n" }] }).state;
  assert.deepEqual(where(next), [5, 7]);
});

test("its lines deleted: kept, outdated, never dropped", () => {
  const state = opened();
  const next = state.update({ changes: { from: lineStart(state, 5), to: lineStart(state, 7) } }).state;
  assert.equal(where(next), "outdated");
  assert.deepEqual(movedAnchors(next), [], "an outdated comment keeps the lines it was stored with");
});

test("a change from disk that rewrites around its lines finds them again by their text", () => {
  const files = new OpenFiles();
  files.open("a.ts", text, [codeCommentsField]);
  const before = files.stateOf("a.ts", null)!;
  files.update("a.ts", null, { effects: setCodeComments.of([comment]) });
  assert.notEqual(files.stateOf("a.ts", null), before);
  // An agent moved the function down and renamed what was above it: the smallest change spans the lines.
  const disk = ["import y from 'y';", "", "const z = 1;", "", "function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i;", "  return sum;", "}", ""].join("\n");
  assert.equal(files.fromDisk("a.ts", disk, null), "applied");
  assert.deepEqual(where(files.stateOf("a.ts", null)!), [7, 8]);
});

// Two functions that both end in "}": a comment on the first one's.
const twoEnds = [...text.split("\n"), "function other() {", "  return 1;", "}"].join("\n");
const onBrace: CodeComment = { ...comment, id: "c2", ...anchorAt(twoEnds.split("\n"), 7, 7) };

test("a short line deleted is outdated, not moved onto the same text further down", () => {
  const state = EditorState.create({ doc: twoEnds, extensions: [codeCommentsField] }).update({ effects: setCodeComments.of([onBrace]) }).state;
  const next = state.update({ changes: { from: lineStart(state, 7), to: lineStart(state, 8) } }).state;
  assert.equal(where(next), "outdated");
  assert.deepEqual(movedAnchors(next), [], "no wrong place is stored");
});

test("opened on a file where its line now holds the same text between other neighbours: outdated", () => {
  // On disk the first function is gone; line 7 is now the other function's "}".
  const disk = ["import x from 'x';", "", "export default 1;", "", "function other() {", "  return 1;", "}"].join("\n");
  const state = EditorState.create({ doc: disk, extensions: [codeCommentsField] }).update({ effects: setCodeComments.of([onBrace]) }).state;
  assert.equal(where(state), "outdated");
});
