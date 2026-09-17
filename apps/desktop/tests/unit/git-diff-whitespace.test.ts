import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDiff } from "../../src/main/git-adapter.js";

/** A branch whose only change is reindentation: the switch must hide it, and
 *  must not hand the same cache key to the diff renderer for both answers. */
function repoWithReindent(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-ws-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.ts"), "function f() {\nreturn 1;\n}\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "work");
  fs.writeFileSync(path.join(dir, "a.ts"), "function f() {\n    return 1;\n}\n");
  git("commit", "-qam", "reindent");
  return dir;
}

test("ignoreWhitespace hides a reindent-only change and keys the cache apart", async () => {
  const dir = repoWithReindent();
  try {
    const shown = await gitDiff(dir, { kind: "branch", base: "main" });
    const hidden = await gitDiff(dir, { kind: "branch", base: "main", ignoreWhitespace: true });
    assert.match(shown.patch, /return 1;/, "the plain diff shows the reindent");
    assert.equal(hidden.patch.trim(), "", "whitespace-only change is hidden");
    assert.notEqual(shown.cacheKey, hidden.cacheKey, "same key would serve a stale patch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a real change survives the switch", async () => {
  const dir = repoWithReindent();
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "function f() {\n    return 2;\n}\n");
    execFileSync("git", ["commit", "-qam", "value"], { cwd: dir });
    const hidden = await gitDiff(dir, { kind: "branch", base: "main", ignoreWhitespace: true });
    assert.match(hidden.patch, /return 2;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
