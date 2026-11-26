// Questions about code through the workspace API (code-intel.ts): the language server's answer
// when one runs here, and when none does, usages by a search for the word and a definition from
// the file's outline, each saying it is only as sure as the syntax.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeFinder } from "../src/code-search.ts";
import { codeIntel, codeSidecar } from "../src/code-intel.ts";

let repo: string;
const call = (name: keyof typeof codeIntel.answers, ...args: unknown[]) =>
  (codeIntel.answers[name] as (c: unknown, ...a: unknown[]) => Promise<unknown>)({ actor: { kind: "person" } }, ...args) as Promise<{ accuracy: string; by: string; value: unknown } | null>;

before(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-intel-")));
  const w = (f: string, t: string) => fs.writeFileSync(path.join(repo, f), t);
  // Python: no language server for it on this machine's PATH in the test (PATH is cut below).
  w("shop.py", "def total(prices):\n    return sum(prices)\n\nclass Cart:\n    def checkout(self):\n        return total([1, 2])\n");
  w("report.py", "from shop import total\n\nprint(total([3]))\nsubtotal = 1\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=a", "-c", "user.email=a@b", "add", "-A");
  git("-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "seed");
  process.env.PATH = path.dirname(process.execPath) + path.delimiter + "/usr/bin" + path.delimiter + "/bin";
});
after(async () => { codeSidecar.close(); await closeFinder(); fs.rmSync(repo, { recursive: true, force: true }); });

test("with no language server, usages are the whole word wherever it is written, at syntax accuracy", async () => {
  const found = await call("code.usages", repo, "shop.py", { line: 1, col: 5 });
  assert.equal(found?.accuracy, "syntax");
  assert.equal(found?.by, "word-search");
  const where = (found!.value as { file: string; span: { start: { line: number; col: number } } }[]).map((l) => `${l.file}:${l.span.start.line}:${l.span.start.col}`).sort();
  // `subtotal` holds the word but is not it.
  assert.deepEqual(where, ["report.py:1:17", "report.py:3:6", "shop.py:1:4", "shop.py:6:15"]);
});

test("with no language server, a definition comes from the file's own outline", async () => {
  const found = await call("code.definition", repo, "shop.py", { line: 6, col: 17 });
  assert.equal(found?.accuracy, "syntax");
  assert.deepEqual(found?.value, [{ file: "shop.py", span: { start: { line: 1, col: 4 }, end: { line: 1, col: 9 } } }]);
});

test("the outline is the file's classes and functions, members under their class", async () => {
  const found = await call("code.outline", repo, "shop.py", { version: 7 });
  assert.equal(found?.accuracy, "syntax");
  assert.deepEqual((found!.value as { name: string; kind: string; children: { name: string; kind: string }[] }[]).map((s) => [s.kind, s.name, s.children.map((c) => [c.kind, c.name])]),
    [["function", "total", []], ["class", "Cart", [["method", "checkout"]]]]);
  assert.equal((found as unknown as { version: number }).version, 7);
});

test("a file outside the workspace, linked from inside it, or in an unknown language is refused before anything runs", async () => {
  await assert.rejects(call("code.outline", repo, "../../etc/passwd.py"));
  await assert.rejects(call("code.outline", repo, "notes.txt"), /no code intelligence/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "code-intel-outside-"));
  fs.writeFileSync(path.join(outside, "secret.py"), "def secret():\n    pass\n");
  fs.symlinkSync(path.join(outside, "secret.py"), path.join(repo, "link.py"));
  await assert.rejects(call("code.outline", repo, "link.py"));
  fs.rmSync(outside, { recursive: true, force: true });
  await assert.rejects(call("code.usages", repo, "shop.py", { line: 0, col: 0 }), /at\.line/);
});

test("a file over 5 MB is refused as file.read refuses it, before anything reads it whole", async () => {
  const big = path.join(repo, "big.py");
  fs.writeFileSync(big, "def big():\n    pass\n");
  fs.truncateSync(big, 6 * 1024 * 1024);
  for (const name of ["code.outline", "code.usages", "code.definition", "code.hover"] as const) {
    await assert.rejects(call(name, repo, "big.py", { line: 1, col: 5 }), { code: "FILE_TOO_BIG", message: /big\.py is 6\.0 MB: code questions read files of at most 5 MB/ }, name);
  }
  fs.rmSync(big);
});

// The TypeScript project the code-intel package tests with: its TypeScript 7 answers here.
const project = path.resolve(import.meta.dirname, "..", "..", "code-intel", "tests", "fixtures", "project");
const as = (actor: unknown) => (name: keyof typeof codeIntel.answers, ...args: unknown[]) =>
  (codeIntel.answers[name] as (c: unknown, ...a: unknown[]) => Promise<unknown>)({ actor }, ...args) as Promise<{ accuracy: string; by: string } | null>;

test("a guest gets syntax answers and starts no language server; the person and an agent here get the compiler's", async () => {
  // `Square` in `new Square(2)` on line 10: the file's own outline holds it.
  const guest = await as({ kind: "peer", person: "p2", device: "d2", access: "edit" })("code.definition", project, "square.ts", { line: 10, col: 33 });
  assert.equal(guest?.accuracy, "syntax");
  const person = await as({ kind: "person" })("code.definition", project, "square.ts", { line: 10, col: 21 });
  assert.equal(person?.accuracy, "compiler");
  const agent = await as({ kind: "peer", person: "t1", device: "t1", access: "agents", client: "claude", tile: "t1" })("code.usages", project, "square.ts", { line: 10, col: 21 });
  assert.equal(agent?.accuracy, "compiler");
});


test("asked with an id, each better answer is sent to the asker as it comes and the reply is the last; taken back, the question answers null", async () => {
  const sent: { event: string; params: unknown[] }[] = [];
  const from = { actor: { kind: "person" }, send: (e: { event: string; params: unknown[] }) => sent.push(e), closed: new AbortController().signal };
  const usages = codeIntel.answers["code.usages"] as (c: unknown, ...a: unknown[]) => Promise<{ accuracy: string } | null>;
  const final = await usages(from, project, "square.ts", { line: 10, col: 21 }, { ask: 7 });
  // Which comes first is a race (a warm server beats the text search); the order is answers.test.ts's.
  const told = sent.filter((e) => e.event === "code.answered" && e.params[0] === 7).map((e) => e.params[1]);
  assert.ok(told.length >= 1);
  assert.deepEqual(told.at(-1), final);
  assert.equal(final?.accuracy, "compiler");

  const asked = usages(from, project, "square.ts", { line: 10, col: 21 }, { ask: 8 });
  codeIntel.notices!["code.cancel"]!(from as never, 8);
  assert.equal(await asked, null);
});
