// Finding with fff (code-search.ts): a file by a typo'd name, a line with where it matched, a grep
// in pages that pick up where the last stopped, the person's picks ranking a file higher, and the
// API refusing a query or a page it should not take. code-search-git.test.ts asks the same of git.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as s from "../src/code-search.ts";
import { code } from "../src/code.ts";
import { findsAFileByATypoedName, findsALineWithWhereItMatched, makeRepo } from "./code-search-cases.ts";

let repo: string;
before(() => { repo = makeRepo(); });
after(async () => { await s.closeFinder(); fs.rmSync(repo, { recursive: true, force: true }); });

test("fff finds a file by a typo'd name, best first, and nothing that does not match", () => findsAFileByATypoedName(s, repo, "fff"));
test("fff finds a line, and says where in it the text matched", () => findsALineWithWhereItMatched(s, repo));

test("a grep comes in pages: the second picks up where the first stopped, and between them every line once", async () => {
  const first = await s.grep(repo, "NEEDLE");
  assert.equal(first.engine, "fff");
  assert.ok(first.next !== null && first.lines.length > 0 && first.lines.length < 300);
  const all = [...first.lines];
  for (let next = first.next; next !== null;) {
    const page = await s.grep(repo, "NEEDLE", { cursor: next });
    all.push(...page.lines);
    next = page.next;
  }
  const keys = all.map((l) => `${l.path}:${l.line}`);
  assert.equal(new Set(keys).size, keys.length, "no line twice");
  assert.equal(keys.length, 300);
});

test("a window's next grep of a repo replaces its one before, which fails as superseded; another window's is answered", async () => {
  const mine = {}, theirs = {};
  const first = s.grep(repo, "NEEDLE", {}, mine);
  const other = s.grep(repo, "NEEDLE", {}, theirs);
  const second = s.grep(repo, "TAX_RATE_MARKER", {}, mine);
  await assert.rejects(first, /superseded/);
  assert.equal((await other).lines.length, 200);
  assert.deepEqual((await second).lines.map((l) => l.path), ["src/checkout/tax.ts"]);
});

test("the API refuses an empty grep, a limit out of range and a file outside the repo, before the engine sees them", async () => {
  const call = async (name: keyof typeof code.answers, ...args: unknown[]) => (code.answers[name] as (c: unknown, ...a: unknown[]) => unknown)({}, ...args);
  await assert.rejects(call("code.grep", repo, ""), /non-empty text/);
  await assert.rejects(call("code.findFiles", repo, "x", 0), /whole number from 1 to 500/);
  await assert.rejects(call("code.grep", repo, "x", { mode: "glob" }), /opts\.mode/);
  await assert.rejects(call("code.picked", repo, "x", "../../etc/passwd"));
});

/** The fff process this test started: a child of this process running code-search-process. */
function fffPid(): number | null {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
      if (ppid === process.pid && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("code-search-process")) return Number(pid);
    } catch { /* gone */ }
  }
  return null;
}

test("a hung fff is killed after its time: git answers that question and that repo from then on, and another repo is fff's again", { skip: process.platform !== "linux" }, async () => {
  const other = makeRepo();
  try {
    assert.equal((await s.grep(repo, "NEEDLE")).engine, "fff");
    const stuck = fffPid();
    assert.ok(stuck);
    process.kill(stuck, "SIGSTOP");
    const started = Date.now();
    const answer = await Promise.race([s.grep(repo, "TAX_RATE_MARKER"), new Promise<null>((r) => setTimeout(() => r(null), s.FFF_ANSWER_MS + 5_000).unref())]);
    if (fffPid() === stuck) process.kill(stuck, "SIGKILL");
    assert.ok(answer, "answered within the time");
    assert.equal(answer.engine, "git");
    assert.deepEqual(answer.lines.map((l) => l.path), ["src/checkout/tax.ts"]);
    assert.ok(Date.now() - started >= s.FFF_ANSWER_MS - 100);
    assert.equal((await s.grep(repo, "NEEDLE")).engine, "git");
    assert.equal((await s.grep(other, "TAX_RATE_MARKER")).engine, "fff");
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
