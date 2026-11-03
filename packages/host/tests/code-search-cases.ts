// The questions both engines answer the same way (code-search.test.ts with fff, code-search-git.test.ts
// with git), against one repository made here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-search-")));
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  w("src/checkout/cart.ts", "export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n");
  w("src/checkout/tax.ts", "export const RATE = 0.2; // TAX_RATE_MARKER\n");
  w("README.md", "# shop\n");
  // Six files of fifty matching lines: more than one page of a grep.
  for (let i = 0; i < 6; i++) w(`logs/log${i}.txt`, Array.from({ length: 50 }, (_, j) => `entry ${i}-${j} NEEDLE`).join("\n") + "\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=a", "-c", "user.email=a@b", "add", "-A");
  git("-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "seed");
  return root;
}

type Search = typeof import("../src/code-search.ts");

export async function findsAFileByATypoedName(s: Search, repo: string, engine: "fff" | "git") {
  const page = await s.findFiles(repo, engine === "fff" ? "chkcart" : "cart");
  assert.equal(page.engine, engine);
  assert.equal(page.files[0]?.path, "src/checkout/cart.ts");
  assert.ok(!page.files.some((f) => f.path.includes("log")), "nothing that does not match");
}

export async function findsALineWithWhereItMatched(s: Search, repo: string) {
  const page = await s.grep(repo, "TAX_RATE_MARKER");
  assert.deepEqual(page.lines.map((l) => [l.path, l.line]), [["src/checkout/tax.ts", 1]]);
  const [from, to] = page.lines[0]!.ranges[0]!;
  assert.equal(page.lines[0]!.text.slice(from, to), "TAX_RATE_MARKER");
}
