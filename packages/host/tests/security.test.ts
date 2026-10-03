// Security hardening regressions: the SessionStart hook command must not be
// shell-injectable via a renderer-controlled tileId, and a workspace API call
// (a window's, the dev-bridge's, later a peer's) may not reach outside its repo
// or hand git an option where it takes a file, a revision or a branch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shq } from "@hivemind/agents/node";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-security-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const server = new WorkspaceServer(workspaceDomains, new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
/** The app's window, as a connection: the person at this machine. */
const window = { actor: { kind: "person" } as const, send: () => {}, closed: new AbortController().signal };
const ask = (method: string, ...params: unknown[]) => server.answer(method, params, window);
const codeOf = async (method: string, ...params: unknown[]) => {
  const answer = await ask(method, ...params);
  return "error" in answer ? answer.error.code : "answered";
};
let repos = 0;
function makeRepo(): string {
  const repo = path.join(tmp, `repo-${repos++}`);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: repo });
  return repo;
}
const stagedIn = (repo: string) => execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo }).toString().split("\n").filter(Boolean);

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

test("a file a call names outside its repo is a bad request: nothing outside is read or written", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(tmp, "secret.txt"), "outside");
  for (const file of ["../secret.txt", path.join(tmp, "secret.txt")]) {
    assert.equal(await codeOf("git.fileContents", repo, file, "WORKING"), "BAD_REQUEST", file);
    assert.equal(await codeOf("git.conflictedFile", repo, file), "BAD_REQUEST", file);
    assert.equal(await codeOf("git.writeResolved", repo, file, "clobbered"), "BAD_REQUEST", file);
    assert.equal(await codeOf("git.discard", repo, [file]), "BAD_REQUEST", file);
    assert.equal(await codeOf("file.read", repo, file), "BAD_REQUEST", file);
    assert.equal(await codeOf("file.write", repo, file, "clobbered"), "BAD_REQUEST", file);
  }
  assert.equal(await codeOf("git.stage", repo, ["a.txt", "../secret.txt"]), "BAD_REQUEST");
  assert.equal(fs.readFileSync(path.join(tmp, "secret.txt"), "utf8"), "outside");
  // Inside the repo, the same calls are answered.
  fs.writeFileSync(path.join(repo, "a.txt"), "inside");
  assert.deepEqual(await ask("git.fileContents", repo, "a.txt", "WORKING"), { result: "inside" });
  assert.deepEqual(await ask("file.read", repo, "a.txt"), { result: "inside" });
});

test("working-tree reads refuse a symlink to a file outside the repo", async () => {
  const repo = makeRepo();
  const secret = path.join(tmp, "outside-secret.txt");
  fs.writeFileSync(secret, "outside secret");
  fs.symlinkSync(secret, path.join(repo, "linked-secret.txt"));
  const outsideDir = path.join(tmp, "outside-dir");
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(repo, "linked-dir"));
  assert.equal(await codeOf("file.read", repo, "linked-secret.txt"), "BAD_REQUEST");
  assert.equal(await codeOf("git.fileContents", repo, "linked-secret.txt", "WORKING"), "BAD_REQUEST");
  assert.equal(await codeOf("file.read", repo, "linked-dir/missing.txt"), "BAD_REQUEST");
  assert.equal(await codeOf("file.read", repo, "missing.txt"), "FAILED");
  assert.deepEqual(await ask("git.fileContents", repo, "missing.txt", "WORKING"), { result: "" });
});

test("a revision a diff names may not be an option: git would write the diff to a file of the caller's choosing", async () => {
  const repo = makeRepo();
  const out = path.join(tmp, "written-by-diff");
  assert.equal(await codeOf("git.diff", repo, { kind: "commit", sha: `--output=${out}` }), "BAD_REQUEST");
  for (const ref of ["base", "head"]) assert.equal(await codeOf("git.diff", repo, { kind: "branch", [ref]: `--output=${out}` }), "BAD_REQUEST", ref);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith("written-by-diff")), []);
  assert.equal(await codeOf("git.diff", repo, { kind: "commit", sha: "HEAD" }), "answered");
});

test("a file named like an option is staged as that file, not read as the option", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "--all"), "x");
  fs.writeFileSync(path.join(repo, "other.txt"), "y");
  assert.deepEqual(await ask("git.stage", repo, ["--all"]), { result: null });
  assert.deepEqual(stagedIn(repo), ["--all"]);
});

test("worktree.create refuses a branch, a path or a list entry that is an option or reaches outside the repo, before any git call", async () => {
  const repo = makeRepo();
  const refused = [
    ...["--force", "a; rm -rf ~", "../evil", "", "-b", "has space"].map((branch) => ({ branch })),
    { branch: "ok", path: "/etc/evil" },
    { branch: "ok", path: "../../escape" },
    { branch: "ok", sparse: ["--exclude-standard"] },
    { branch: "ok", includeFiles: ["/etc/passwd"] },
    { branch: "ok", includeFiles: ["../../.ssh/id_rsa"] },
  ];
  for (const opts of refused) assert.equal(await codeOf("worktree.create", repo, opts), "BAD_REQUEST", JSON.stringify(opts));
  assert.equal(execFileSync("git", ["branch", "--list"], { cwd: repo }).toString().trim().split("\n").length, 1);
});
