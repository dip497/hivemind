// Finding where fff cannot load (code-search.ts's fallback): the same questions answered from git, its
// file list scored by fzf and `git grep`, in one page. Where the `hive` binary and a remote repo run.
import { after, before, test } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { findsAFileByATypoedName, findsALineWithWhereItMatched, makeRepo } from "./code-search-cases.ts";

process.env.HIVEMIND_FFF = "0";
const s = await import("../src/code-search.ts");

let repo: string;
before(() => { repo = makeRepo(); });
after(() => fs.rmSync(repo, { recursive: true, force: true }));

test("without fff, git's file list scored by fzf finds the file, best first", () => findsAFileByATypoedName(s, repo, "git"));
test("without fff, git grep finds the line and where in it the text matched", () => findsALineWithWhereItMatched(s, repo));
test("without fff, a grep is one page of at most 200 lines, saying there is no next", async () => {
  const page = await s.grep(repo, "NEEDLE");
  assert.deepEqual([page.engine, page.lines.length, page.next], ["git", 200, null]);
});
