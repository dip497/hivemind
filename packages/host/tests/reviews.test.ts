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

test("a change the rules refuse is refused with the reason; a comment not there is not found", async () => {
  const dir = await repo();
  const c = await addComment(path.join(dir, ".hivemind"), note);
  await call("review.resolve", dir, c.id, "done");
  await assert.rejects(call("review.seen", dir, c.id), (e: unknown) => e instanceof ApiError && e.code === "BAD_REQUEST" && /resolved/.test(e.message));
  await call("review.reopen", dir, c.id);
  await assert.rejects(call("review.dismiss", dir, c.id, " "), (e: unknown) => e instanceof ApiError && e.code === "BAD_REQUEST" && /reason/.test(e.message));
  await assert.rejects(call("review.seen", dir, "c-nope"), (e: unknown) => e instanceof ApiError && e.code === "NOT_FOUND");
});
