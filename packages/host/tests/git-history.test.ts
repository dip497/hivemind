// History on a workspace's host (docs/design/git-history-2026-11-02.md), against real repositories
// made here: the log a page at a time and across branches, a file's history through a rename,
// blame of the editor's text, a commit's files, git's commit-graph kept with Bloom filters (or
// not, when the person turned it off), and the params the API refuses before git sees them.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILE_PAGE, forgetHistory, gitBlame, gitCommitInfo, gitFileHistory, gitLog, keepCommitGraph } from "../src/git-history.ts";
import { git as gitDomain } from "../src/git.ts";

let root: string;
let repo: string;
const sh = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "", GIT_COMMITTER_DATE: "" } }).trim();
let n = 0;
/** A commit at a time a second apart, so the order by date is the order made. */
function commit(dir: string, message: string, files: Record<string, string | null>) {
  for (const [f, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(dir, f));
    else { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  }
  sh(dir, "add", "-A");
  const at = `${1_700_000_000 + ++n} +0000`;
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  return sh(dir, "rev-parse", "HEAD");
}

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-history-")));
  repo = path.join(root, "shop");
  fs.mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Ada");
  sh(repo, "config", "user.email", "ada@example.com");
  // cart.js's life: made, changed, renamed to cart.ts, changed again.
  commit(repo, "add cart", { "cart.js": "let total = 0;\nfunction add(x) { total += x; }\nmodule.exports = { add };\n" });
  commit(repo, "cart: name the sum", { "cart.js": "let sum = 0;\nfunction add(x) { sum += x; }\nmodule.exports = { add };\n" });
  commit(repo, "cart in TypeScript", { "cart.js": null, "cart.ts": "let sum = 0;\nfunction add(x) { sum += x; }\nmodule.exports = { add };\n" });
  commit(repo, "cart: types\n\nA body that says why.", { "cart.ts": "let sum = 0;\nexport function add(x: number) { sum += x; }\n", "README.md": "# shop\n" });
  // Enough of another file's commits to need a second page.
  for (let i = 0; i < FILE_PAGE + 5; i++) commit(repo, `log line ${i}`, { "log.txt": `line ${i}\n` });
  // A branch the current one does not have.
  sh(repo, "branch", "feature");
  sh(repo, "checkout", "-q", "feature");
  commit(repo, "on the feature branch", { "feature.txt": "f\n" });
  sh(repo, "checkout", "-q", "main");
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the log: the current branch in pages, `next` until the last; every branch by date with what points at each", async () => {
  forgetHistory();
  const first = await gitLog(repo, { limit: 50 });
  assert.equal(first.commits.length, 50);
  assert.equal(first.commits[0]!.subject, `log line ${FILE_PAGE + 4}`);
  assert.deepEqual(first.commits[0]!.refs, ["HEAD -> main"]);
  assert.equal(first.next, 50);
  let all = first.commits.length;
  for (let cursor = first.next; cursor !== null;) {
    const page = await gitLog(repo, { limit: 50, cursor });
    all += page.commits.length;
    cursor = page.next;
  }
  assert.equal(all, 4 + FILE_PAGE + 5, "every commit of main once, and no more");
  // Its own branch only: the feature branch's commit is not in it.
  assert.ok(!first.commits.some((c) => c.subject === "on the feature branch"));
  const everywhere = await gitLog(repo, { all: true, limit: 3 });
  assert.equal(everywhere.commits[0]!.subject, "on the feature branch", "the newest commit of any branch first");
  assert.deepEqual(everywhere.commits[0]!.refs, ["feature"]);
  assert.equal(everywhere.commits[0]!.parents.length, 1);
});

test("a file's history goes through its rename: the commits under its name now, then under the name it had", async () => {
  forgetHistory();
  const page = await gitFileHistory(repo, "cart.ts");
  assert.deepEqual(page.entries.map((e) => [e.subject, e.path]), [["cart: types", "cart.ts"], ["cart in TypeScript", "cart.ts"]]);
  assert.equal(page.entries[1]!.renamedFrom, "cart.js");
  assert.ok(page.next);
  const before = await gitFileHistory(repo, "cart.ts", page.next!);
  assert.deepEqual(before.entries.map((e) => [e.subject, e.path]), [["cart: name the sum", "cart.js"], ["add cart", "cart.js"]]);
  assert.equal(before.next, null);
  // A long history in pages: the second one picks up where the first stopped.
  const one = await gitFileHistory(repo, "log.txt");
  assert.equal(one.entries.length, FILE_PAGE);
  const two = await gitFileHistory(repo, "log.txt", one.next!);
  assert.deepEqual(two.entries.map((e) => e.subject), ["log line 4", "log line 3", "log line 2", "log line 1", "log line 0"]);
  assert.equal(two.next, null);
});

test("blame: each run of lines with the commit that last changed it; the editor's unsaved lines read as not committed, and a range only those lines", async () => {
  forgetHistory();
  const types = sh(repo, "log", "-1", "--format=%H", "--grep=cart: types");
  const sum = sh(repo, "log", "-1", "--format=%H", "--grep=cart: name the sum");
  const committed = await gitBlame(repo, "cart.ts");
  assert.equal(committed.contents, false);
  // Through the rename: line 1 is from before it, line 2 from after.
  assert.deepEqual(committed.hunks.map((h) => [h.start, h.lines, h.oid, h.author]), [[1, 1, sum, "Ada"], [2, 1, types, "Ada"]]);

  const edited = await gitBlame(repo, "cart.ts", { contents: "let sum = 0;\nexport function add(x: number) { sum += x; }\nexport const reset = () => { sum = 0; };\n" });
  assert.equal(edited.contents, true);
  assert.deepEqual(edited.hunks.map((h) => [h.start, h.lines, h.oid]), [[1, 1, sum], [2, 1, types], [3, 1, null]]);

  const second = await gitBlame(repo, "cart.ts", { from: 2, to: 2 });
  assert.deepEqual(second.hunks.map((h) => [h.start, h.oid]), [[2, types]]);
});

test("a commit: its message whole, its parent, and each file with how it changed and by how many lines, a rename named with its old path", async () => {
  forgetHistory();
  const renamed = await gitCommitInfo(repo, sh(repo, "log", "-1", "--format=%H", "--grep=cart in TypeScript"));
  assert.deepEqual(renamed.files, [{ path: "cart.ts", status: "renamed", from: "cart.js", add: 0, del: 0 }]);
  const typed = await gitCommitInfo(repo, sh(repo, "log", "-1", "--format=%H", "--grep=cart: types"));
  assert.equal(typed.message, "cart: types\n\nA body that says why.");
  assert.equal(typed.parents.length, 1);
  assert.deepEqual(typed.files.map((f) => [f.path, f.status, f.add, f.del]), [["README.md", "added", 1, 0], ["cart.ts", "modified", 1, 2]]);
});

test("git's commit-graph is written with Bloom filters where history is shown, and not when the person turned it off", async () => {
  const graphs = (dir: string) => path.join(dir, ".git/objects/info/commit-graphs");
  const off = path.join(root, "off");
  fs.mkdirSync(off);
  sh(off, "init", "-q", "-b", "main");
  sh(off, "config", "user.name", "Ada");
  sh(off, "config", "user.email", "ada@example.com");
  commit(off, "one", { "a.txt": "a\n" });
  process.env.HIVEMIND_COMMIT_GRAPH = "0";
  try { await keepCommitGraph(off); } finally { delete process.env.HIVEMIND_COMMIT_GRAPH; }
  assert.equal(fs.existsSync(graphs(off)), false);

  await keepCommitGraph(repo);
  assert.ok(fs.existsSync(path.join(graphs(repo), "commit-graph-chain")));
  // The Bloom filters are there: git's own trace says it read a path's history through them.
  execFileSync("git", ["log", "-1", "--format=%H", "--", "cart.ts"], { cwd: repo, env: { ...process.env, GIT_TRACE2_EVENT: path.join(root, "trace.json") } });
  assert.match(fs.readFileSync(path.join(root, "trace.json"), "utf8"), /"category":"bloom"/);
});

test("the API refuses, before git sees them, a cursor git would read as an option or a path outside the repo", async () => {
  // As the server calls it: a refusal thrown at once is the call's rejection.
  const call = async (name: "git.fileHistory" | "git.blame" | "git.log", ...args: unknown[]) =>
    (gitDomain.answers[name] as (ctx: unknown, ...a: unknown[]) => Promise<unknown>)({}, ...args);
  await assert.rejects(call("git.fileHistory", repo, "cart.ts", { rev: "--output=/tmp/x", path: "cart.ts", skip: 0 }), /may not begin with "-"/);
  await assert.rejects(call("git.fileHistory", repo, "cart.ts", { rev: "main~3", path: "cart.ts", skip: 0 }), /not one a page gives/);
  await assert.rejects(call("git.fileHistory", repo, "cart.ts", { rev: "HEAD", path: "../../etc/passwd", skip: 0 }));
  await assert.rejects(call("git.blame", repo, "cart.ts", { from: 0 }), /whole number/);
  await assert.rejects(call("git.log", repo, { limit: 5000 }), /whole number from 1 to 1000/);
});
