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

test("the API refuses an empty grep, a limit out of range and a file outside the repo, before the engine sees them", async () => {
  const call = async (name: keyof typeof code.answers, ...args: unknown[]) => (code.answers[name] as (c: unknown, ...a: unknown[]) => unknown)({}, ...args);
  await assert.rejects(call("code.grep", repo, ""), /non-empty text/);
  await assert.rejects(call("code.findFiles", repo, "x", 0), /whole number from 1 to 500/);
  await assert.rejects(call("code.grep", repo, "x", { mode: "glob" }), /opts\.mode/);
  await assert.rejects(call("code.picked", repo, "x", "../../etc/passwd"));
});
