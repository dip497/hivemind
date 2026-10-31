import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_ATTACHMENT_BYTES, addComment, attachToComment, checkAttachment, deleteComment, dismissComment, listComments, markSeen, normalizeComments, pageFilePath, readComments, reopenComment,
  replyTo, resolveComment, reviewPath, reviewRoot, statusOf, writeComments, writePicture, type PageComment,
} from "./review.js";

const root = async () => fs.mkdtemp(path.join(os.tmpdir(), "hm-review-"));
const seed = {
  file: "src/a.ts", startLine: 3, endLine: 5, side: "additions" as const,
  body: "this leaks", author: "you",
};

describe("review comments", () => {
  test("a note's picture stays out of the project's git history", async () => {
    const dir = await root();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const reviews = path.join(dir, ".hivemind");
    await writePicture(reviews, "c1", new Uint8Array([1, 2, 3]));
    const untracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
    expect(untracked).not.toContain("c1.png");
    expect(await fs.readFile(path.join(reviews, "pages", "c1.png"))).toHaveLength(3);
  });

  test("a link a cloned project committed is replaced, and what it points at is left alone", async () => {
    const outside = path.join(await root(), "precious");
    await fs.writeFile(outside, "keep");
    const reviews = await root();
    await fs.mkdir(path.join(reviews, "pages"));
    await fs.symlink(outside, path.join(reviews, "pages", ".gitignore"));
    await fs.symlink(outside, path.join(reviews, "pages", "c1.png"));
    await fs.symlink(outside, reviewPath(reviews));

    await writePicture(reviews, "c1", new Uint8Array([1, 2, 3]));
    await writeComments(reviews, []);

    expect(await fs.readFile(outside, "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(reviews, "pages", "c1.png"))).isFile()).toBe(true);
    expect((await fs.lstat(reviewPath(reviews))).isFile()).toBe(true);
  });

  test("a pictures folder that is a link is refused, and nothing lands where it points", async () => {
    const elsewhere = await root();
    const reviews = await root();
    await fs.symlink(elsewhere, path.join(reviews, "pages"));
    await expect(writePicture(reviews, "c1", new Uint8Array([1]))).rejects.toThrow("not a folder");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  test("a project whose .hivemind is a link keeps its notes in the config folder, not where the link points", async () => {
    const repo = await root();
    const elsewhere = await root();
    const home = await root();
    await fs.symlink(elsewhere, path.join(repo, ".hivemind"));
    const r = await reviewRoot(repo, home);
    expect(r.startsWith(path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "hivemind", "review"))).toBe(true);
  });

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

  describe("what a note keeps", () => {
    const made = async (name: string, bytes = "video bytes"): Promise<string> => {
      const file = path.join(await root(), name);
      await fs.writeFile(file, bytes);
      return file;
    };
    const pages = (r: string) => path.join(r, "pages");
    const inPages = async (r: string) => (await fs.readdir(pages(r)).catch(() => [] as string[])).filter((f) => f !== ".gitignore").sort();

    test("proof is copied in under a made-up name, recorded by name alone, and stays out of git", async () => {
      const dir = await root();
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const r = path.join(dir, ".hivemind");
      const c = await addComment(r, { ...pageNote, id: "c1" });
      const video = await made("my clip; rm -rf.webm");
      const done = (await resolveComment(r, c.id, "fixed", [video, await made("SHOT.PNG", "picture bytes")])) as PageComment;
      expect(statusOf(done)).toBe("resolved");
      expect(done.attachments).toEqual(["c1-1.webm", "c1-2.png"]);
      expect(await fs.readFile(path.join(pages(r), "c1-1.webm"), "utf8")).toBe("video bytes");
      expect(await fs.readFile(video, "utf8")).toBe("video bytes");
      expect(((await readComments(r))[0] as PageComment).attachments).toEqual(["c1-1.webm", "c1-2.png"]);
      expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" })).not.toContain("c1-1.webm");
      // A later one does not take an earlier one's name.
      const more = (await attachToComment(r, c.id, [await made("more.gif")])) as PageComment;
      expect(more.attachments).toEqual(["c1-1.webm", "c1-2.png", "c1-3.gif"]);
      expect(statusOf(more)).toBe("resolved");
    });

    test("a file that cannot be kept is refused by a code of its own, and nothing is copied or changed", async () => {
      const r = await root();
      const c = await addComment(r, { ...pageNote, id: "c1" });
      const tooBig = await made("huge.mp4");
      await fs.truncate(tooBig, MAX_ATTACHMENT_BYTES + 1);
      const cases: [string, string][] = [
        [await made("notes.exe"), "ATTACHMENT_TYPE"],
        [await made("noextension"), "ATTACHMENT_TYPE"],
        [path.join(await root(), "gone.png"), "ATTACHMENT_MISSING"],
        [await fs.mkdir(path.join(await root(), "folder.png"), { recursive: true }).then((p) => p!), "ATTACHMENT_MISSING"],
        [tooBig, "ATTACHMENT_TOO_BIG"],
      ];
      for (const [file, code] of cases) {
        await expect(resolveComment(r, c.id, "done", [await made("fine.png"), file]), file).rejects.toMatchObject({ code });
      }
      expect(statusOf((await readComments(r))[0]!)).toBe("open");
      expect(await inPages(r)).toEqual([]);
      const atTheCap = await made("just-fits.mp4");
      await fs.truncate(atTheCap, MAX_ATTACHMENT_BYTES);
      await checkAttachment(atTheCap);
    });

    test("proof on what cannot take it is not copied: a closed note, none by that id, a comment on a diff", async () => {
      const r = await root();
      const closed = await addComment(r, { ...pageNote, id: "c1", resolved: true });
      const diff = await addComment(r, { ...seed, id: "c2" });
      const video = await made("a.webm");
      await expect(resolveComment(r, closed.id, "again", [video])).rejects.toThrow("reopen it first");
      expect(await resolveComment(r, "c-nope", "done", [video])).toBeNull();
      await expect(attachToComment(r, diff.id, [video])).rejects.toMatchObject({ code: "ATTACHMENT_NOT_A_NOTE" });
      expect(await inPages(r)).toEqual([]);
    });

    test("a copy that fails partway leaves no file behind and the note as it was", async () => {
      const r = await root();
      const c = await addComment(r, { ...pageNote, id: "c1" });
      const unreadable = await made("locked.webm");
      await fs.chmod(unreadable, 0);
      await expect(attachToComment(r, c.id, [await made("fine.png"), unreadable])).rejects.toThrow();
      expect(await fs.readdir(pages(r)).then((files) => files.filter((f) => f !== ".gitignore"))).toEqual([]);
      expect(((await readComments(r))[0] as PageComment).attachments).toBeUndefined();
    });

    test("a link a cloned project committed at a proof's name is replaced, and what it points at is left alone", async () => {
      const outside = await made("precious.webm", "keep");
      const r = await root();
      const c = await addComment(r, { ...pageNote, id: "c1" });
      await fs.mkdir(pages(r));
      await fs.symlink(outside, path.join(pages(r), "c1-1.webm"));
      await attachToComment(r, c.id, [await made("a.webm")]);
      expect(await fs.readFile(outside, "utf8")).toBe("keep");
      expect((await fs.lstat(path.join(pages(r), "c1-1.webm"))).isFile()).toBe(true);
    });

    test("a pictures folder that is a link takes no proof, and nothing lands where it points", async () => {
      const elsewhere = await root();
      const r = await root();
      const c = await addComment(r, { ...pageNote, id: "c1" });
      await fs.symlink(elsewhere, pages(r));
      await expect(attachToComment(r, c.id, [await made("a.webm")])).rejects.toThrow("not a folder");
      expect(await fs.readdir(elsewhere)).toEqual([]);
    });

    test("deleting a note deletes its picture and its proof, and no other note's", async () => {
      const r = await root();
      await addComment(r, { ...pageNote, id: "c1", page: { ...pageNote.page, picture: await writePicture(r, "c1", new Uint8Array([1])) } });
      await addComment(r, { ...pageNote, id: "c2", page: { ...pageNote.page, picture: await writePicture(r, "c2", new Uint8Array([2])) } });
      await attachToComment(r, "c1", [await made("a.webm")]);
      await attachToComment(r, "c2", [await made("b.webm")]);
      expect(await deleteComment(r, "c1")).toBe(true);
      expect(await inPages(r)).toEqual(["c2-1.webm", "c2.png"]);
      expect((await readComments(r)).map((c) => c.id)).toEqual(["c2"]);
      expect(await deleteComment(r, "c-nope")).toBe(false);
    });

    test("deleting a note removes nothing through a pictures folder that is a link", async () => {
      const elsewhere = await root();
      await fs.writeFile(path.join(elsewhere, "c1.png"), "keep");
      const r = await root();
      await fs.symlink(elsewhere, pages(r));
      await addComment(r, { ...pageNote, id: "c1", page: { ...pageNote.page, picture: "c1.png" } });
      await deleteComment(r, "c1");
      expect(await fs.readFile(path.join(elsewhere, "c1.png"), "utf8")).toBe("keep");
    });

    test("a note's file is found to show it by its name alone; a path, a link or what no note could hold is not", async () => {
      const r = await root();
      await fs.mkdir(pages(r));
      const secret = await made("secret.png");
      await fs.writeFile(path.join(pages(r), "c1-1.webm"), "x");
      await fs.writeFile(path.join(pages(r), "c1.png"), "x");
      await fs.writeFile(path.join(pages(r), "page.html"), "x");
      await fs.symlink(secret, path.join(pages(r), "c2.png"));
      expect(await pageFilePath(r, "c1-1.webm")).toBe(path.join(pages(r), "c1-1.webm"));
      expect(await pageFilePath(r, "c1.png")).toBe(path.join(pages(r), "c1.png"));
      for (const name of ["c2.png", "page.html", ".gitignore", "missing.png", "../review.json", `../${path.basename(secret)}`, secret]) {
        expect(await pageFilePath(r, name), name).toBeNull();
      }
      const linked = await root();
      await fs.symlink(pages(r), pages(linked));
      expect(await pageFilePath(linked, "c1.png")).toBeNull();
    });

    test("attachments on disk are file names, never paths, and on a note alone", () => {
      const names = ["c-1-1.webm", "c-1-2.mp4", "x.png", "x.jpg", "x.gif", "../x.png", "/etc/x.png", "a/b.webm", "a\\b.webm", ".x.png", "x.exe", "x.html", "", 7, null];
      const [kept] = normalizeComments([{ id: "c-1", ...pageNote, attachments: names }]);
      expect((kept as PageComment).attachments).toEqual(["c-1-1.webm", "c-1-2.mp4", "x.png", "x.jpg", "x.gif"]);
      const [none] = normalizeComments([{ id: "c-2", ...pageNote, attachments: ["../x.png"] }]);
      expect(none).not.toHaveProperty("attachments");
      const [onDiff] = normalizeComments([{ id: "c-3", ...seed, attachments: ["x.png"] }]);
      expect(onDiff).not.toHaveProperty("attachments");
    });
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
