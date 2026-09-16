import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addComment, listComments, normalizeComments, readComments, reopenComment,
  replyTo, resolveComment, reviewPath, writeComments,
} from "./review.js";

const root = async () => fs.mkdtemp(path.join(os.tmpdir(), "hm-review-"));
const seed = {
  file: "src/a.ts", startLine: 3, endLine: 5, side: "additions" as const,
  body: "this leaks", author: "you",
};

describe("review comments", () => {
  test("a comment round-trips through the file the CLI reads", async () => {
    const r = await root();
    const added = await addComment(r, seed);
    expect(added.id).toMatch(/^c-/);
    expect(added.resolved).toBeUndefined();
    expect(reviewPath(r).endsWith("review.json")).toBe(true);
    expect((await readComments(r)).map((c) => c.body)).toEqual(["this leaks"]);
  });

  test("reply, resolve and reopen change one comment and keep the rest", async () => {
    const r = await root();
    const a = await addComment(r, seed);
    const b = await addComment(r, { ...seed, body: "and this" });
    await replyTo(r, a.id, { author: "claude", body: "fixed in abc123", at: "2026-09-16T00:00:00.000Z" });
    const resolved = await resolveComment(r, a.id, "fixed");
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.summary).toBe("fixed");
    expect(resolved?.replies).toHaveLength(1);
    expect((await listComments(r, { status: "open" })).map((c) => c.id)).toEqual([b.id]);
    expect((await listComments(r, { status: "resolved" })).map((c) => c.id)).toEqual([a.id]);
    expect(await listComments(r, { status: "all" })).toHaveLength(2);
    const reopened = await reopenComment(r, a.id);
    expect(reopened?.resolved).toBeUndefined();
    expect(reopened?.summary).toBeUndefined();
    expect(reopened?.replies).toHaveLength(1);
  });

  test("resolving an id that is not there reports it instead of writing", async () => {
    const r = await root();
    await addComment(r, seed);
    expect(await resolveComment(r, "c-nope", "x")).toBeNull();
    expect(await listComments(r)).toHaveLength(1);
  });

  test("filtering by file only returns that file's comments", async () => {
    const r = await root();
    await addComment(r, seed);
    await addComment(r, { ...seed, file: "src/b.ts" });
    expect((await listComments(r, { file: "src/b.ts" })).map((c) => c.file)).toEqual(["src/b.ts"]);
  });

  test("junk on disk never throws — a half-written file reads as no comments", async () => {
    const r = await root();
    await fs.writeFile(reviewPath(r), "{not json", "utf8");
    expect(await readComments(r)).toEqual([]);
    expect(await listComments(r)).toEqual([]);
  });

  test("normalize drops entries with no file or body and clamps the line range", () => {
    const list = normalizeComments([
      { id: "c-1", file: "a.ts", body: "ok", startLine: 9, endLine: 2, side: "nonsense" },
      { id: "c-2", file: "a.ts" },
      { id: "c-3", body: "no file" },
      "garbage",
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "c-1", startLine: 9, endLine: 9, side: "additions" });
    expect(list[0]!.author).toBe("unknown");
  });

  test("a write is atomic — no .tmp is left behind", async () => {
    const r = await root();
    await writeComments(r, normalizeComments([{ id: "c-1", file: "a.ts", body: "b" }]));
    expect((await fs.readdir(r)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
