// Migration of persisted diff review comments: old single-line shape → the
// range + threads model. Existing reviews must survive the upgrade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeComments } from "../../src/renderer/src/diff-comments.ts";

test("legacy single-line comment migrates to a range with an id", () => {
  const out = normalizeComments([
    { file: "a.ts", line: 12, side: "additions", body: "fix this", author: "you", at: "2026-05-28 10:00" },
  ]);
  assert.equal(out.length, 1);
  const c = out[0]!;
  assert.equal(c.file, "a.ts");
  assert.equal(c.startLine, 12);
  assert.equal(c.endLine, 12);
  assert.equal(c.side, "additions");
  assert.equal(c.body, "fix this");
  assert.equal(c.resolved, false);
  assert.deepEqual(c.replies, []);
  assert.ok(c.id, "assigns an id");
});

test("already-migrated range comment is preserved", () => {
  const out = normalizeComments([
    { id: "c-1", file: "b.ts", startLine: 3, endLine: 7, side: "deletions", body: "range", author: "you", at: "x", resolved: true, replies: [{ author: "you", body: "r", at: "y" }] },
  ]);
  const c = out[0]!;
  assert.equal(c.id, "c-1");
  assert.equal(c.startLine, 3);
  assert.equal(c.endLine, 7);
  assert.equal(c.resolved, true);
  assert.equal(c.replies?.length, 1);
});

test("non-array / garbage → empty", () => {
  assert.deepEqual(normalizeComments(null), []);
  assert.deepEqual(normalizeComments({}), []);
  assert.deepEqual(normalizeComments("nope"), []);
});
