import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addComment, listComments, moveComment, normalizeComments, readComments, writeComments } from "./review.js";
import { anchorAt, codeCommentsMessage, findCodeAnchor, onCode, onDiff, type CodeComment } from "./review-shape.js";

const file = [
  "import x from 'x';",
  "",
  "function total(items) {",
  "  let sum = 0;",
  "  for (const i of items) sum += i;",
  "  return sum;",
  "}",
  "",
  "export default total;",
];
// The loop and its return, lines 5-6.
const anchor = anchorAt(file, 5, 6);

describe("finding a code comment's lines again after the file changed", () => {
  test("lines inserted above move it down", () => {
    const now = ["// header", "// more", ...file];
    expect(findCodeAnchor(now, anchor)).toEqual({ startLine: 7, endLine: 8 });
  });

  test("its own lines edited in place keep it on them, between the same neighbours", () => {
    const now = [...file.slice(0, 4), "  for (const item of items) {", "    sum += item;", "  }", "  return sum;", ...file.slice(6)];
    expect(findCodeAnchor(now, anchor)).toEqual({ startLine: 5, endLine: 8 });
  });

  test("its lines deleted leave it outdated", () => {
    const now = [...file.slice(0, 4), ...file.slice(6)];
    expect(findCodeAnchor(now, anchor)).toBeNull();
  });

  test("its lines deleted with the same closing lines further down: outdated, not moved onto them", () => {
    const now = [...file.slice(0, 4), ...file.slice(6), "function other() {", "  return 1;", "}", ""];
    expect(findCodeAnchor(now, anchor)).toBeNull();
  });

  test("the same lines twice: the copy with the same neighbours wins, not the nearer one", () => {
    const now = ["  for (const i of items) sum += i;", "  return sum;", ...file];
    expect(findCodeAnchor(now, anchor)).toEqual({ startLine: 7, endLine: 8 });
  });

  test("a short line deleted is outdated, not moved onto the same text with other neighbours", () => {
    // A comment on the function's closing brace (line 7); another function ends the same way.
    const two = [...file.slice(0, 8), "function other() {", "  return 1;", "}"];
    const brace = anchorAt(two, 7, 7);
    const now = [...two.slice(0, 6), ...two.slice(7)];
    expect(findCodeAnchor(now, brace)).toBeNull();
  });

  test("blank lines around it are no evidence when the other side has words", () => {
    const two = ["  return 1;", "}", "", "", "  return 2;", "}", ""];
    // The second brace: above it a line with words, below it a blank line.
    const brace = anchorAt(two, 6, 6);
    const now = ["  return 1;", "}", "", "", ""];
    expect(findCodeAnchor(now, brace)).toBeNull();
  });

  test("a line whose neighbours both changed is outdated; with one neighbour the same it is found", () => {
    const one = anchorAt(file, 5, 5);
    const bothChanged = [...file.slice(0, 3), "  let sum = 1;", file[4], "  return sum + 0;", ...file.slice(6)];
    expect(findCodeAnchor(bothChanged, one)).toBeNull();
    const aboveChanged = ["// header", ...file.slice(0, 3), "  let sum = 1;", ...file.slice(4)];
    expect(findCodeAnchor(aboveChanged, one)).toEqual({ startLine: 6, endLine: 6 });
  });

  test("a file of one line, nothing around it, is still found", () => {
    expect(findCodeAnchor(["}"], anchorAt(["}"], 1, 1))).toEqual({ startLine: 1, endLine: 1 });
  });
});

describe("code comments in review.json", () => {
  const root = () => fs.mkdtemp(path.join(os.tmpdir(), "hm-code-comments-"));
  const seed = { file: "src/total.ts", ...anchor, body: "why not reduce?", author: "you", intent: "question" as const };

  test("kept with their text and neighbours, told apart from comments on a diff", async () => {
    const dir = await root();
    const made = await addComment(dir, seed);
    const [read] = await readComments(dir);
    expect(read).toEqual(made);
    expect(onCode(read!) && read.text).toBe("  for (const i of items) sum += i;\n  return sum;");
    expect(onDiff(read!)).toBe(false);
    expect(await listComments(dir, { on: "code" })).toHaveLength(1);
    expect(await listComments(dir, { on: "diff" })).toHaveLength(0);
    expect(await listComments(dir, { on: "notes" })).toHaveLength(0);
    expect(await listComments(dir, { file: "src/total.ts" })).toHaveLength(1);
  });

  test("an empty neighbour at the top of a file is kept, not dropped", () => {
    const [c] = normalizeComments([{ id: "c1", ...seed, ...anchorAt(file, 1, 1) }]);
    expect(c && onCode(c) && c.before).toBe("");
  });

  test("moved to where its lines are now; a comment on a diff refuses to move", async () => {
    const dir = await root();
    const c = await addComment(dir, seed);
    const moved = await moveComment(dir, c.id, anchorAt(["// a", "// b", ...file], 7, 8));
    expect(moved && onCode(moved) && [moved.startLine, moved.endLine]).toEqual([7, 8]);
    await writeComments(dir, [...(await readComments(dir)), ...normalizeComments([{ id: "d1", file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "x", author: "you" }])]);
    await expect(moveComment(dir, "d1", anchor)).rejects.toThrow("not on a file's lines");
  });

  test("sent to an agent as @file#L with the lines and how to answer", () => {
    const [c] = normalizeComments([{ id: "c1", ...seed }]) as CodeComment[];
    const text = codeCommentsMessage([c!]);
    expect(text).toContain("c1 (question): @src/total.ts#L5-6\nwhy not reduce?\n```\n  for (const i of items) sum += i;\n  return sum;\n```");
    expect(text).toContain("hive review reply <id>");
  });

  test("lines from a file with unsaved edits say so, since the file on disk numbers them differently", () => {
    const [c] = normalizeComments([{ id: "c1", ...seed }]) as CodeComment[];
    expect(codeCommentsMessage([c!], (x) => x.file === "src/total.ts")).toContain("c1 (question): @src/total.ts#L5-6 (unsaved: lines as the editor has them; on disk find them by the text below)\n");
    expect(codeCommentsMessage([c!], () => false)).not.toContain("unsaved");
  });
});
