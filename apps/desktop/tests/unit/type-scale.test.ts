// The Layers panel, its menus and a frame's header set text in one scale, so a row, a heading
// and a count read the same wherever they appear: 15 the title, 14 a row, 12 a heading or a menu,
// 11 a count or a key, 10 a status chip. A size off it, a named size or an inline one fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SCALE = new Set([10, 11, 12, 14, 15]);
const FILES = ["LayersPanel.tsx", "FrameMenu.tsx", "FrameNode.tsx", "components/ui/dropdown-menu.tsx"];
const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "../../src/renderer/src", f), "utf8");

/** What in `text` sets a size off the scale, by line. */
export function offScale(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) if (!SCALE.has(Number(m[1]))) out.push(`${i + 1}: ${m[0]}`);
    for (const m of line.matchAll(/\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/g)) out.push(`${i + 1}: ${m[0]}`);
    if (/fontSize\s*:/.test(line)) out.push(`${i + 1}: fontSize`);
  });
  return out;
}

test("the scale check finds a size off it, a named size and an inline one", () => {
  assert.deepEqual(offScale('<span className="text-[13px]" />\n<p className="text-sm" style={{ fontSize: 9 }} />'), ["1: text-[13px]", "2: text-sm", "2: fontSize"]);
  assert.deepEqual(offScale('<span className="text-[12px] text-[var(--color-fg)]" />'), []);
});

for (const f of FILES) {
  test(`${f} sets text only in the panel's scale`, () => {
    assert.deepEqual(offScale(src(f)), []);
  });
}
