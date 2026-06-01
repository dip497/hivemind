// gitignore handling: the diff / file tree must hide gitignored files — both
// the easy untracked-ignored case AND a file that was committed and only LATER
// added to .gitignore (git still surfaces those because .gitignore can't
// untrack; we filter them with `git check-ignore --no-index`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitStatus, gitListFiles } from "../../src/main/git-adapter.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hm-gi-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "app.js"), "real\n");
  writeFileSync(path.join(dir, "config.json"), "v1\n");
  writeFileSync(path.join(dir, ".gitignore"), "");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  // config.json is tracked; NOW gitignore it (+ a dir of build artifacts).
  writeFileSync(path.join(dir, ".gitignore"), "config.json\nbuild/\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-qm", "ignore");
  // dirty everything + add untracked (one allowed, one ignored).
  appendFileSync(path.join(dir, "app.js"), "more\n");
  appendFileSync(path.join(dir, "config.json"), "v2\n"); // tracked + ignored
  writeFileSync(path.join(dir, "newfile.tmp"), "x\n"); // untracked, allowed
  mkdirSync(path.join(dir, "build"));
  writeFileSync(path.join(dir, "build", "out.js"), "x\n"); // untracked + ignored
  return dir;
}

test("gitStatus hides tracked-but-gitignored files, keeps real changes", async () => {
  const dir = makeRepo();
  try {
    const snap = await gitStatus(dir);
    const paths = snap.files.map((f) => f.path).sort();
    assert.ok(paths.includes("app.js"), "real modified file shown");
    assert.ok(paths.includes("newfile.tmp"), "untracked non-ignored file shown");
    assert.ok(!paths.includes("config.json"), "tracked+gitignored file HIDDEN");
    assert.ok(!paths.includes("build/out.js"), "untracked+ignored file HIDDEN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitListFiles hides tracked-but-gitignored files", async () => {
  const dir = makeRepo();
  try {
    const files = await gitListFiles(dir);
    assert.ok(files.includes("app.js"));
    assert.ok(files.includes(".gitignore"));
    assert.ok(files.includes("newfile.tmp"));
    assert.ok(!files.includes("config.json"), "tracked+gitignored file HIDDEN");
    assert.ok(!files.includes("build/out.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
