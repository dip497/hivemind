// Security hardening regressions: the SessionStart hook command must not be
// shell-injectable via a renderer-controlled tileId, and worktreeCreate must
// reject git-arg injection / path escapes before it ever shells out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shq } from "../../src/main/claude-resume.ts";
import { worktreeCreate } from "../../src/main/git-adapter.ts";

test("shq: a single-quoted value can't break out of the hook command", () => {
  assert.equal(shq("hm:tile-1"), "'hm:tile-1'");
  // Injection attempt: the inner quote is rewritten ('\''), never left to close
  // the quoting — so the `; rm -rf ~` stays INSIDE the single-quoted literal.
  assert.equal(shq("x'; rm -rf ~ #"), "'x'\\''; rm -rf ~ #'");
  for (const s of ["", "a'b", "''", "a'b'c", "no-quotes"]) {
    const q = shq(s);
    assert.ok(q.startsWith("'") && q.endsWith("'"), `balanced wrap for ${JSON.stringify(s)}`);
  }
});

test("worktreeCreate rejects an injecting/escaping branch name (before any git call)", async () => {
  for (const branch of ["--force", "a; rm -rf ~", "../evil", "", "-b", "has space"]) {
    await assert.rejects(() => worktreeCreate("/tmp/hm-nope", { branch }), /invalid branch/);
  }
});

test("worktreeCreate rejects absolute/`..` paths and dash-prefixed list entries", async () => {
  await assert.rejects(() => worktreeCreate("/tmp/hm-nope", { branch: "ok", path: "/etc/evil" }), /relative/);
  await assert.rejects(() => worktreeCreate("/tmp/hm-nope", { branch: "ok", path: "../../escape" }), /relative/);
  await assert.rejects(() => worktreeCreate("/tmp/hm-nope", { branch: "ok", sparse: ["--exclude-standard"] }), /invalid sparse/);
  await assert.rejects(() => worktreeCreate("/tmp/hm-nope", { branch: "ok", includeFiles: ["/etc/passwd"] }), /invalid includeFiles/);
});
