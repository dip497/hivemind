// The design system's scales, held for the whole renderer and the tools bundled with it
// (DESIGN.md): text is set in the named steps, colours are defined once as custom properties,
// corners come from the radius scale. A literal in their place is drift, and fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APP = path.join(import.meta.dirname, "../..");
const ROOTS = ["src/renderer/src", "tools"];

/** Every source file in scope, relative to the app. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(tsx?|css)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel);
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

/** The text with comments blanked, line breaks kept so line numbers hold. */
function code(text: string, css: boolean): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const block = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return css ? block : block.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

const at = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Literal font sizes: off the named steps, whatever the size. */
export function literalSizes(text: string, css: boolean): string[] {
  const src = code(text, css), out: string[] = [];
  const hits = css
    ? [...src.matchAll(/\bfont(?:-size)?\s*:[^;{}]*?\b\d+(?:\.\d+)?(?:px|rem)\b/g)]
    : [
        ...src.matchAll(/\btext-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g),
        ...src.matchAll(/(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g),
        ...src.matchAll(/\bfontSize\s*:\s*(?:\d|["']\d[^"']*["'])/g),
        ...src.matchAll(/["']--[\w-]*font-size["']\s*:\s*["']\d/g),
      ];
  for (const m of hits) out.push(`${at(src, m.index!)}: ${m[0]}`);
  return out;
}

const COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|(?<![a-zA-Z])(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/g;

/** Colour literals outside a custom property's definition. */
export function literalColours(text: string, css: boolean): string[] {
  const src = code(text, css), out: string[] = [];
  if (css) {
    // A declaration that defines a custom property is where a colour is named; any other
    // declaration uses one.
    for (const d of src.matchAll(/[^;{}]+/g)) {
      if (/^\s*--[\w-]+\s*:/.test(d[0])) continue;
      for (const m of d[0].matchAll(COLOUR)) out.push(`${at(src, d.index! + m.index!)}: ${m[0]}`);
    }
  } else {
    for (const m of src.matchAll(COLOUR)) out.push(`${at(src, m.index!)}: ${m[0]}`);
  }
  return out;
}

const RADII = new Set([4, 5, 6, 8, 10, 12, 14, 999]);

/** Corners off the radius scale. */
export function offScaleRadii(text: string, css: boolean): string[] {
  const src = code(text, css), out: string[] = [];
  const hits = css
    ? [...src.matchAll(/\bborder(?:-[a-z]+)*-radius\s*:\s*([^;{}]+)/g)].filter((m) =>
        [...m[1].matchAll(/(\d+(?:\.\d+)?)px/g)].some((n) => !RADII.has(Number(n[1]))))
    : [
        ...src.matchAll(/\brounded(?:-[a-z]{1,2})?-\[\d[^\]]*\]/g),
        ...[...src.matchAll(/\bborderRadius\s*:\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/g)].filter((m) => !RADII.has(Number(m[1]))),
      ];
  for (const m of hits) out.push(`${at(src, m.index!)}: ${m[0].trim()}`);
  return out;
}

/** Files that are palettes: their colours are data a person picks or a scanner reads, not chrome. */
const PALETTES: Record<string, string> = {
  "src/renderer/src/frame-color.ts": "the frame colours a person picks",
  "src/renderer/src/multiplayer/people.ts": "the colours a person picks for themselves",
  "src/renderer/src/components/qr-code.tsx": "a QR code is black on white for any scanner",
  "src/renderer/src/workspace/css-color.ts": "resolves a CSS colour on a canvas",
  "tools/issues/src/StateMeta.tsx": "the issue states' own colours",
};

/** One literal in one file, where the value is handed to a library that needs a colour string. */
const LITERALS: Record<string, string[]> = {
  "src/renderer/src/TerminalTile.tsx": ["rgba(0,0,0,0)"],
};

test("each check finds what it names, and passes the system's own spelling", () => {
  assert.deepEqual(literalSizes('<p className="text-[11.5px] text-sm" style={{ fontSize: 10 }} />', false), ["1: text-[11.5px]", "1: text-sm", "1: fontSize: 1"]);
  assert.deepEqual(literalSizes('<p className="text-label text-[var(--color-fg)]" style={{ fontSize: `${n}px` }} />', false), []);
  assert.deepEqual(literalSizes(".a { font-size: 12.5px; }\n.b { font: 11px/1.5 var(--font-mono); }\n.c { font-size: var(--text-body); }", true), ["1: font-size: 12.5px", "2: font: 11px"]);
  assert.deepEqual(literalColours('.a { --scrim: oklch(0 0 0 / .5); background: var(--scrim); }\n.b { box-shadow: 0 1px 2px rgba(0,0,0,.2); }', true), ["2: rgba(0,0,0,.2)"]);
  assert.deepEqual(literalColours('/* #fff */ .a { color: #e5484d; }', true), ["1: #e5484d"]);
  assert.deepEqual(literalColours('const a = "var(--color-err)"; // was #e5484d\nconst b = "#c084fc";', false), ["2: #c084fc"]);
  assert.deepEqual(offScaleRadii(".a { border-radius: 3px; }\n.b { border-radius: 6px 6px 0 0; }", true), ["1: border-radius: 3px"]);
  assert.deepEqual(offScaleRadii('<i className="rounded-[10px] rounded-t-[3px] rounded-menu rounded-[inherit]" />', false), ["1: rounded-[10px]", "1: rounded-t-[3px]"]);
  assert.deepEqual(offScaleRadii('const a = { borderRadius: 3 }, b = { borderRadius: "4px" }, c = { borderRadius: r.radius };', false), ["1: borderRadius: 3"]);
});

for (const f of sources()) {
  const css = f.endsWith(".css");
  const text = () => fs.readFileSync(path.join(APP, f), "utf8");
  test(`${f} sets text in the named steps`, () => assert.deepEqual(literalSizes(text(), css), []));
  test(`${f} takes its colours from tokens`, () => {
    if (PALETTES[f]) return;
    const allowed = LITERALS[f] ?? [];
    assert.deepEqual(literalColours(text(), css).filter((h) => !allowed.some((a) => h.endsWith(`: ${a}`))), []);
  });
  test(`${f} rounds corners on the scale`, () => assert.deepEqual(offScaleRadii(text(), css), []));
}
