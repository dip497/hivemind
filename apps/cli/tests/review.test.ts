// `hive review` as an agent uses it on notes left on a page: it lists them apart from a diff's
// comments, shows what each points at and where its picture is, and answers them by the rules.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addComment } from "@hivemind/core";
import { hive } from "./helpers";

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
