// The workspace's review comments as its host answers for them: a diff's save keeps the notes on
// pages, and a change the rules refuse comes back as a refusal that says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { addComment, readComments } from "@hivemind/core/review";
import { reviews } from "../src/reviews.js";

const from = { id: "you", role: "owner" } as never;
const call = (method: keyof typeof reviews.answers, ...params: unknown[]) => (reviews.answers[method] as (...a: unknown[]) => Promise<unknown>)(from, ...params);

async function repo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-reviews-"));
  fs.mkdirSync(path.join(dir, ".hivemind"));
  return dir;
}
const note = { page: { url: "http://localhost:3000/", viewport: { width: 800, height: 600 }, elements: [{ name: 'button "Go"', selector: "#go", box: { x: 1, y: 2, width: 3, height: 4 } }] }, body: "bigger", author: "you" };

test("saving a diff's comments keeps the notes on pages, which the diff never shows", async () => {
  const dir = await repo();
  const root = path.join(dir, ".hivemind");
  const kept = await addComment(root, note);
  await call("review.save", dir, [{ id: "c-d", file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "rename", author: "you" }]);
  assert.deepEqual((await readComments(root)).map((c) => c.id).sort(), ["c-d", kept.id].sort());
});

test("a note pinned on the board stays through a diff's save, and its words for an agent say where it is and how to answer", async () => {
  const dir = await repo();
  const root = path.join(dir, ".hivemind");
  const pinned = await addComment(root, { body: "add rate limits", author: "you", board: { on: "shape-1", x: 4, y: 5, what: "API" } });
  await call("review.save", dir, [{ id: "c-d", file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "rename", author: "you" }]);
  assert.deepEqual((await readComments(root)).map((c) => c.id).sort(), ["c-d", pinned.id].sort());
  const words = await call("review.message", dir, [pinned.id, "c-d"]) as string;
  assert.match(words, /1 note on the board to address/);
  assert.match(words, /add rate limits/);
  assert.match(words, /pinned on shape-1 "API"/);
  assert.match(words, /hive ctl notes done/);
  assert.doesNotMatch(words, /rename/, "a comment on a diff is sent its own way");
});

test("a change the rules refuse is refused with the reason; a comment not there is not found", async () => {
  const dir = await repo();
  const c = await addComment(path.join(dir, ".hivemind"), note);
  await call("review.resolve", dir, c.id, "done");
  await assert.rejects(call("review.seen", dir, c.id), (e: unknown) => e instanceof ApiError && e.code === "BAD_REQUEST" && /resolved/.test(e.message));
  await call("review.reopen", dir, c.id);
  await assert.rejects(call("review.dismiss", dir, c.id, " "), (e: unknown) => e instanceof ApiError && e.code === "BAD_REQUEST" && /reason/.test(e.message));
  await assert.rejects(call("review.seen", dir, "c-nope"), (e: unknown) => e instanceof ApiError && e.code === "NOT_FOUND");
});

const onCode = { file: "src/a.ts", startLine: 2, endLine: 3, text: "b\nc", before: "a", after: "d", body: "why?", intent: "question" };

test("a comment on code is added by the person, kept through a diff's save, moved, and never sent as a note", async () => {
  const dir = await repo();
  const root = path.join(dir, ".hivemind");
  const made = await call("review.add", dir, { ...onCode, author: "an agent" }) as { id: string; author: string };
  assert.equal(made.author, "you");
  await call("review.save", dir, [{ id: "c-d", file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "rename", author: "you" }]);
  assert.deepEqual((await readComments(root)).map((c) => c.id).sort(), ["c-d", made.id].sort());
  const moved = await call("review.move", dir, made.id, { startLine: 5, endLine: 6, text: "b\nc", before: "x\na", after: "d" }) as { startLine: number; text: string };
  assert.equal(moved.startLine, 5);
  assert.equal(await call("review.message", dir, [made.id]), null);
  await assert.rejects(call("review.move", dir, "c-d", { startLine: 1, endLine: 1, text: "", before: "", after: "" }), (e: ApiError) => e.code === "BAD_REQUEST");
  await assert.rejects(call("review.add", dir, { file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "x" }), (e: ApiError) => e.code === "BAD_REQUEST");
});
