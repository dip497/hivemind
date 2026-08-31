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
import { gitStatus, gitListFiles, gitCommit, gitPull } from "../../src/main/git-adapter.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
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

/** A bare "remote" + two clones, so pull/commit hit real refs. */
function makeRemoteAndClones(): { remote: string; a: string; b: string } {
  const remote = mkdtempSync(path.join(tmpdir(), "hm-remote-"));
  git(remote, "init", "-q", "--bare");
  const a = mkdtempSync(path.join(tmpdir(), "hm-clone-a-"));
  git(a, "clone", "-q", remote, ".");
  git(a, "config", "user.email", "a@t.com");
  git(a, "config", "user.name", "a");
  writeFileSync(path.join(a, "f.txt"), "1\n");
  git(a, "add", "-A");
  git(a, "commit", "-qm", "init");
  git(a, "push", "-q", "-u", "origin", "HEAD");
  const b = mkdtempSync(path.join(tmpdir(), "hm-clone-b-"));
  git(b, "clone", "-q", remote, ".");
  git(b, "config", "user.email", "b@t.com");
  git(b, "config", "user.name", "b");
  return { remote, a, b };
}

test("gitCommit records a commit and returns its sha", async () => {
  const { remote, a, b } = makeRemoteAndClones();
  try {
    writeFileSync(path.join(a, "f.txt"), "2\n");
    git(a, "add", "-A");
    const { sha } = await gitCommit(a, "second");
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(gitOut(a, "rev-parse", "HEAD"), sha);
    assert.equal(gitOut(a, "log", "-1", "--pretty=%s"), "second");
  } finally {
    for (const d of [remote, a, b]) rmSync(d, { recursive: true, force: true });
  }
});

test("gitPull fast-forwards the current branch from upstream", async () => {
  const { remote, a, b } = makeRemoteAndClones();
  try {
    // A pushes a new commit; B pulls it.
    writeFileSync(path.join(a, "f.txt"), "2\n");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "from-a");
    git(a, "push", "-q");
    await gitPull(b);
    assert.equal(gitOut(b, "log", "-1", "--pretty=%s"), "from-a");
  } finally {
    for (const d of [remote, a, b]) rmSync(d, { recursive: true, force: true });
  }
});

test("gitPull (--ff-only) rejects a diverged branch", async () => {
  const { remote, a, b } = makeRemoteAndClones();
  try {
    // A advances the remote.
    writeFileSync(path.join(a, "f.txt"), "2\n");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "from-a");
    git(a, "push", "-q");
    // B makes its OWN divergent commit (does not fetch), so ff-only must fail.
    writeFileSync(path.join(b, "g.txt"), "b\n");
    git(b, "add", "-A");
    git(b, "commit", "-qm", "from-b");
    await assert.rejects(() => gitPull(b), /fast-forward|ff-only|diverg|rejected/i);
  } finally {
    for (const d of [remote, a, b]) rmSync(d, { recursive: true, force: true });
  }
});
