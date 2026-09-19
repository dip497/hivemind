// The repo watcher skips what git ignores, so build output is never scanned or watched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { underIgnored } from "../../src/main/fs-watcher.ts";

test("paths under a gitignored folder are skipped, tracked ones and look-alikes are not", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-watch-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, ".gitignore"), "target/\n*.log\n");
  mkdirSync(path.join(repo, "target", "debug", "deps"), { recursive: true });
  writeFileSync(path.join(repo, "target", "debug", "deps", "a.rlib"), "");
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "main.rs"), "");
  writeFileSync(path.join(repo, "run.log"), "");
  const out = execFileSync("git", ["-C", repo, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { encoding: "utf8" });
  const ignored = new Set(out.split("\0").filter(Boolean).map((e) => e.replace(/\/$/, "")));
  assert.ok(underIgnored(repo, path.join(repo, "target"), ignored));
  assert.ok(underIgnored(repo, path.join(repo, "target", "debug", "deps", "a.rlib"), ignored));
  assert.ok(underIgnored(repo, path.join(repo, "run.log"), ignored));
  assert.ok(!underIgnored(repo, path.join(repo, "src", "main.rs"), ignored));
  assert.ok(!underIgnored(repo, path.join(repo, "targets.md"), ignored));
  assert.ok(!underIgnored(repo, repo, ignored));
});
