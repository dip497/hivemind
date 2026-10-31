// `hive review` as an agent uses it on notes left on a page: it lists them apart from a diff's
// comments, shows what each points at and where its picture is, and answers them by the rules.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addComment } from "@hivemind/core";
import { hive } from "./helpers";

function proof(name: string, size = 16): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hive-proof-")), name);
  fs.writeFileSync(file, "x".repeat(16));
  fs.truncateSync(file, size);
  return file;
}

function workspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-review-")));
  fs.mkdirSync(path.join(dir, ".hivemind"));
  return dir;
}
const pageNote = {
  page: {
    url: "http://localhost:3000/pricing", viewport: { width: 1280, height: 800 }, picture: "c-note.png",
    elements: [{ name: 'button "Start trial"', selector: "#trial", text: "Start trial", box: { x: 10, y: 20, width: 120, height: 40 } }],
  },
  body: "too small on phones", author: "you", intent: "fix" as const, id: "c-note",
};

test("an agent lists the notes on a page, reads one with its picture, and answers it by the rules", async () => {
  const dir = workspace();
  await addComment(path.join(dir, ".hivemind"), pageNote);
  await addComment(path.join(dir, ".hivemind"), { file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "rename", author: "you" });

  const listed = hive(["review", "list", "--on", "page", "--json"], { cwd: dir });
  expect(listed.code).toBe(0);
  expect((listed.json as { comments: { id: string }[] }).comments.map((c) => c.id)).toEqual(["c-note"]);

  const shown = hive(["review", "show", "c-note"], { cwd: dir });
  expect(shown.stdout).toContain('button "Start trial": `#trial`');
  expect(shown.stdout).toContain(`picture: ${path.join(dir, ".hivemind", "pages", "c-note.png")}`);

  expect(hive(["review", "seen", "c-note", "--json"], { cwd: dir }).json).toMatchObject({ seen: true });
  const noReason = hive(["review", "dismiss", "c-note", "--reason", " ", "--json"], { cwd: dir });
  expect(noReason.code).not.toBe(0);
  expect(JSON.stringify(noReason.json)).toContain("REVIEW_REASON");
  expect(hive(["review", "dismiss", "c-note", "--reason", "works as designed", "--json"], { cwd: dir }).json).toMatchObject({ resolved: true, dismissed: true, summary: "works as designed" });
  const again = hive(["review", "seen", "c-note", "--json"], { cwd: dir });
  expect(again.code).not.toBe(0);
  expect(JSON.stringify(again.json)).toContain("REVIEW_STATE");
});

test("hive ctl notes lists only the notes on pages, and answers one: seen, done, reopened, dismissed", async () => {
  const dir = workspace();
  await addComment(path.join(dir, ".hivemind"), pageNote);
  await addComment(path.join(dir, ".hivemind"), { file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "rename", author: "you" });
  const listed = hive(["ctl", "notes", "list", "--json"], { cwd: dir });
  expect(listed.code).toBe(0);
  expect((listed.json as { comments: { id: string }[] }).comments.map((c) => c.id)).toEqual(["c-note"]);
  expect(hive(["ctl", "notes", "seen", "c-note", "--json"], { cwd: dir }).json).toMatchObject({ seen: true });
  expect(hive(["ctl", "notes", "done", "c-note", "--summary", "bigger now", "--json"], { cwd: dir }).json).toMatchObject({ resolved: true, summary: "bigger now" });
  expect(hive(["ctl", "notes", "reopen", "c-note", "--json"], { cwd: dir }).json).not.toHaveProperty("resolved");
  expect(hive(["ctl", "notes", "dismiss", "c-note", "--reason", "by design", "--json"], { cwd: dir }).json).toMatchObject({ dismissed: true });
  expect(hive(["ctl", "notes", "list", "--status", "resolved"], { cwd: dir }).stdout).toContain("dismissed");
});

test("hive ctl notes done keeps proof on a note: its names in --json, and where each is in show", { timeout: 30_000 }, async () => {
  const dir = workspace();
  await addComment(path.join(dir, ".hivemind"), pageNote);
  const done = hive(["ctl", "notes", "done", "c-note", "--summary", "bigger now", "--attach", proof("clip.webm"), "--attach", proof("after.png"), "--json"], { cwd: dir });
  expect(done.code).toBe(0);
  expect(done.json).toMatchObject({ resolved: true, summary: "bigger now", attachments: ["c-note-1.webm", "c-note-2.png"] });
  const pages = path.join(dir, ".hivemind", "pages");
  expect(fs.statSync(path.join(pages, "c-note-1.webm")).size).toBe(16);
  const shown = hive(["ctl", "notes", "show", "c-note"], { cwd: dir });
  expect(shown.stdout).toContain(`attachment: ${path.join(pages, "c-note-1.webm")}`);
  expect(shown.stdout).toContain(`attachment: ${path.join(pages, "c-note-2.png")}`);
  // A relative path means from where the agent is.
  const reopened = hive(["ctl", "notes", "reopen", "c-note", "--json"], { cwd: dir });
  expect(reopened.code).toBe(0);
  fs.writeFileSync(path.join(dir, "here.gif"), "x");
  expect(hive(["ctl", "notes", "done", "c-note", "--attach", "here.gif", "--json"], { cwd: dir }).json).toMatchObject({ attachments: ["c-note-1.webm", "c-note-2.png", "c-note-3.gif"] });
});

test("hive ctl notes done refuses a file it cannot keep: a stable code and exit, a fix, and the note left open", { timeout: 30_000 }, async () => {
  const dir = workspace();
  await addComment(path.join(dir, ".hivemind"), pageNote);
  const rows: [string, string, number, string][] = [
    [proof("notes.exe"), "ATTACHMENT_TYPE", 7, ".webm"],
    [proof("huge.mp4", 200 * 1024 * 1024 + 1), "ATTACHMENT_TOO_BIG", 7, "200 MB"],
    [path.join(dir, "gone.png"), "ATTACHMENT_MISSING", 5, "path"],
  ];
  for (const [file, code, exit, fix] of rows) {
    const r = hive(["ctl", "notes", "done", "c-note", "--attach", file, "--json"], { cwd: dir });
    expect([r.code, (r.json as { error: { code: string } }).error.code]).toEqual([exit, code]);
    expect((r.json as { error: { fix: string } }).error.fix).toContain(fix);
  }
  expect((hive(["ctl", "notes", "list", "--json"], { cwd: dir }).json as { comments: { id: string }[] }).comments.map((c) => c.id)).toEqual(["c-note"]);
});

test("hive ctl notes add refuses what needs no app to refuse: no tile to say where, a file it cannot keep, an area that is no area", { timeout: 30_000 }, () => {
  const dir = workspace();
  // A socket nothing serves: reaching for the app here would say UNAVAILABLE instead.
  const env = { HIVE_DRIVE_SOCK: path.join(dir, "no-app.sock") };
  const rows: [string[], string, number, string][] = [
    [["--selector", "#x"], "NO_BROWSER_TILE", 5, "--tile"],
    [["--selector", "#x", "--tile", "b1", "--attach", proof("notes.exe")], "ATTACHMENT_TYPE", 7, ".webm"],
    [["--area", "1,2,3", "--tile", "b1"], "BAD_REQUEST", 2, "--help"],
    [["--selector", "#x", "--tile", "b1"], "UNAVAILABLE", 3, "app"],
  ];
  for (const [args, code, exit, fix] of rows) {
    const r = hive(["ctl", "notes", "add", "--body", "broken", ...args, "--json"], { cwd: dir, env });
    expect([args.join(" "), r.code, (r.json as { error: { code: string } }).error.code]).toEqual([args.join(" "), exit, code]);
    expect((r.json as { error: { fix: string } }).error.fix).toContain(fix);
  }
});
