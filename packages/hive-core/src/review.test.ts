import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addComment, dismissComment, listComments, markSeen, normalizeComments, readComments, reopenComment,
  replyTo, resolveComment, reviewPath, reviewRoot, statusOf, writeComments,
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

  test("a workspace keeps comments with the code; a plain repo does not become one", async () => {
    const home = await root();
    const repo = path.join(home, "work", "repo");
    await fs.mkdir(path.join(repo, ".hivemind"), { recursive: true });
    expect(await reviewRoot(repo, home)).toBe(path.join(repo, ".hivemind"));

    const bare = path.join(home, "work", "bare");
    await fs.mkdir(bare, { recursive: true });
    const elsewhere = await reviewRoot(bare, home);
    expect(elsewhere.startsWith(bare)).toBe(false);
    await addComment(elsewhere, seed);
    // Leaving a comment must not conjure a .hivemind/ the CLI would treat as a root.
    expect(await fs.exists(path.join(bare, ".hivemind"))).toBe(false);
  });

  test("a write is atomic — no .tmp is left behind", async () => {
    const r = await root();
    await writeComments(r, normalizeComments([{ id: "c-1", file: "a.ts", body: "b" }]));
    expect((await fs.readdir(r)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  const pageNote = {
    page: {
      url: "http://localhost:3000/pricing",
      viewport: { width: 1280, height: 800 },
      elements: [{ name: 'button "Start trial"', selector: "main > .hero > button", text: "Start trial", box: { x: 10, y: 20, width: 120, height: 40 } }],
      picture: "c-1.png",
    },
    body: "too small on phones", author: "you", intent: "fix" as const,
  };

  test("a note on a page round-trips with what it points at, and lists apart from the diff's", async () => {
    const r = await root();
    await addComment(r, seed);
    const note = await addComment(r, pageNote);
    const back = (await readComments(r)).find((c) => c.id === note.id)!;
    expect(back).toMatchObject({ body: "too small on phones", intent: "fix", page: { url: "http://localhost:3000/pricing", picture: "c-1.png" } });
    expect((await listComments(r, { on: "page" })).map((c) => c.id)).toEqual([note.id]);
    expect(await listComments(r, { on: "diff" })).toHaveLength(1);
    expect(await listComments(r, { file: "src/a.ts" })).toHaveLength(1);
  });

  test("a comment moves open → seen → resolved, or is dismissed with a reason, and only a closed one reopens", async () => {
    const r = await root();
    const a = await addComment(r, pageNote);
    expect(statusOf((await markSeen(r, a.id))!)).toBe("seen");
    expect(statusOf((await resolveComment(r, a.id, "bigger now"))!)).toBe("resolved");
    await expect(markSeen(r, a.id)).rejects.toThrow("resolved");
    await expect(resolveComment(r, a.id)).rejects.toThrow("reopen it first");
    expect(statusOf((await reopenComment(r, a.id))!)).toBe("open");
    await expect(reopenComment(r, a.id)).rejects.toThrow("only a resolved or dismissed comment");
    await expect(dismissComment(r, a.id, "  ")).rejects.toThrow("needs a reason");
    const dismissed = (await dismissComment(r, a.id, "works as intended"))!;
    expect(statusOf(dismissed)).toBe("dismissed");
    expect(dismissed.summary).toBe("works as intended");
    // Dismissed is closed: it lists with the resolved ones.
    expect((await listComments(r, { status: "resolved" })).map((c) => c.id)).toEqual([a.id]);
  });

  test("a page note's picture is a file name, never a path", () => {
    const [kept, escaped] = normalizeComments([
      { id: "c-1", ...pageNote },
      { id: "c-2", ...pageNote, page: { ...pageNote.page, picture: "../../.ssh/id_rsa.png" } },
    ]);
    expect(kept!.page.picture).toBe("c-1.png");
    expect(escaped!.page.picture).toBeUndefined();
  });
});
