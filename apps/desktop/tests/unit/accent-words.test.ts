// No words in the accent (apps/desktop/DESIGN.md, Steel Accent): the person may pick any colour,
// and it is held to 3:1 as a mark (core's ACCENT_SURFACES, accentMarkInk), never to the 4.5:1 a word
// needs. This scans the renderer and the tools the app ships (loaded into the same page, so they
// resolve the same tokens) for a text colour taken from `--color-brand`, `--color-accent` or
// `--color-info`: a Tailwind `text-[var(…)]` (with any variant, such as `hover:`) or a `color:`
// declaration in CSS or an inline style. A mark takes `--color-brand-mark`, which is fitted to 3:1
// on the surfaces marks sit on. It is a scan of the source because the contract is about every
// page, most of which no test opens; the e2e `accent-text` checks real pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOTS = [path.join(APP, "src/renderer/src"), ...fs.readdirSync(path.join(APP, "tools")).map((t) => path.join(APP, "tools", t, "src"))];
const ACCENT = String.raw`var\(--color-(?:brand|accent|info)\)`;
const WORDS = [
  new RegExp(String.raw`(?:^|[\s"'\x60{])(?:[\w-]+:)*text-\[${ACCENT}\]`),
  new RegExp(String.raw`(?<![\w-])color:\s*["'\x60]?${ACCENT}`),
];

function* files(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") yield* files(p); }
    else if (/\.(tsx?|css)$/.test(e.name)) yield p;
  }
}

test("no text in the renderer or the app's tools takes its colour from the accent", () => {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const f of files(root)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (WORDS.some((re) => re.test(line))) found.push(`${path.relative(APP, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(found, []);
});
