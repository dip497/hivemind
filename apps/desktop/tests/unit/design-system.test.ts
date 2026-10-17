// The design system's scales, held for the whole renderer and the tools bundled with it
// (DESIGN.md): text is set in the named steps, colours are defined once as custom properties,
// corners come from the radius scale, controls stand at the control heights, a choice is the
// app's Select and focus is drawn by one rule. A literal or a second way in their place is drift, and fails here.
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

/** A native <select>: drawn by the operating system, with its accent and its list. */
export function nativeSelects(text: string, css: boolean): string[] {
  if (css) return [];
  const src = code(text, css);
  return [...src.matchAll(/<select\b/g)].map((m) => `${at(src, m.index!)}: ${m[0]}`);
}

/** The one focus rule: styles.css draws the ring from --color-focus, and only it may take it off. */
const FOCUS_HOME = "src/renderer/src/styles.css";

/** A focus ring drawn anywhere but the one rule. */
export function ownFocusRings(text: string, css: boolean, home = false): string[] {
  const src = code(text, css), out: string[] = [];
  if (css) {
    for (const m of src.matchAll(/([^{}]*:focus[^{}]*)\{([^{}]*)\}/g)) {
      if (!/\b(?:outline|box-shadow)\b/.test(m[2])) continue;
      const ours = home && (/outline\s*:\s*2px solid var\(--color-focus\)/.test(m[2]) || /^\s*outline\s*:\s*none;?\s*$/.test(m[2]));
      if (!ours) out.push(`${at(src, m.index! + m[0].search(/\S/))}: ${m[1].trim()}`);
    }
  } else {
    for (const m of src.matchAll(/\bfocus(?:-visible|-within)?:(?:ring|outline|border-ring|shadow)[^\s"'`]*/g)) out.push(`${at(src, m.index!)}: ${m[0]}`);
  }
  return out;
}

/** The opening tag of each named component, braces and strings skipped so `=>` does not end it. */
function openingTags(src: string, names: string[]): { name: string; text: string; index: number }[] {
  const out: { name: string; text: string; index: number }[] = [];
  for (const m of src.matchAll(new RegExp(`<(${names.join("|")})\\b`, "g"))) {
    let i = m.index! + m[0].length, depth = 0, quote = "";
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) { if (c === quote && src[i - 1] !== "\\") quote = ""; }
      else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ name: m[1]!, text: src.slice(m.index!, i + 1), index: m.index! });
  }
  return out;
}

const HEIGHT = /(?<![\w-])(?:min-|max-)?(?:h|size)-(?:\d[\w.]*|\[[^\]]+\]|control(?:-compact)?)(?![\w-])/g;

/** A control given its own height where it is used: its size prop picks one of the control heights. */
export function setHeights(text: string): string[] {
  const src = code(text, false), out: string[] = [];
  for (const t of openingTags(src, ["Button", "Input", "SelectTrigger"]))
    for (const h of t.text.match(HEIGHT) ?? []) out.push(`${at(src, t.index)}: <${t.name} ${h}`);
  return out;
}

/** The heights a control may stand at (DESIGN.md): 32 and 28, and 24, 20, 16 in tile chrome. */
const CONTROL_HEIGHTS = new Set(["h-control", "h-control-compact", "h-6", "h-5", "h-4", "size-control", "size-control-compact", "size-6", "size-5", "size-4"]);

/** Each size of a control primitive, by the height its classes give it: the `size` variants when
 *  it has them, else every height in the component's own function. */
export function controlSizes(text: string, component?: string): string[] {
  let src = code(text, false);
  const out: string[] = [];
  if (component) src = src.slice(src.indexOf(`function ${component}(`)).split(/\n(?=function |export )/)[0]!;
  const block = /\bsize:\s*\{([^}]*)\}/.exec(src);
  const entries = block
    ? [...block[1]!.matchAll(/["']?([\w-]+)["']?\s*:\s*["']([^"']*)["']/g)].map((m) => [m[1]!, m[2]!] as const)
    : [...src.matchAll(/["'`]([^"'`]*\bh-[^"'`]*)["'`]/g)].map((m) => ["", m[1]!] as const);
  for (const [name, classes] of entries)
    for (const c of classes.split(/\s+/).filter((c) => /^(?:h|size)-/.test(c)))
      if (!CONTROL_HEIGHTS.has(c)) out.push(name ? `${name}: ${c}` : c);
  return out;
}

/** The primitives whose height is the control scale, and the component in each that has it. */
const CONTROLS: Record<string, string | undefined> = {
  "src/renderer/src/components/ui/button.tsx": undefined,
  "src/renderer/src/components/ui/input.tsx": "Input",
  "src/renderer/src/components/ui/select.tsx": "SelectTrigger",
};

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
  "src/renderer/src/terminal-look.ts": ["rgba(0,0,0,0)"],
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
  assert.deepEqual(nativeSelects('<Select value={v}>\n<select value={v}>', false), ["2: <select"]);
  assert.deepEqual(ownFocusRings('<b className="outline-none focus:bg-secondary focus-visible:ring-2 focus:outline-none" />', false), ["1: focus-visible:ring-2", "1: focus:outline-none"]);
  const rules = ":focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }\n.x:focus-visible { outline: none; }\n.y:focus { border-color: red; }\n.z:focus-visible { box-shadow: 0 0 0 2px var(--color-brand); }";
  assert.deepEqual(ownFocusRings(rules, true, true), ["4: .z:focus-visible"]);
  assert.deepEqual(ownFocusRings(rules, true), ["1: :focus-visible", "2: .x:focus-visible", "4: .z:focus-visible"]);
  assert.deepEqual(setHeights('<Button size="sm" onClick={() => go(a > b)} className="h-7 w-full" />\n<Input className="size-[30px]" />\n<div className="h-7" />'), ["1: <Button h-7", "2: <Input size-[30px]"]);
  assert.deepEqual(controlSizes('const b = cva("", { variants: { size: { default: "h-control px-2", lg: "h-9 px-6", icon: "size-control [&_svg]:size-3" } } });'), ["lg: h-9"]);
  assert.deepEqual(controlSizes('function A() { return cn("rounded-md", size === "sm" ? "h-7 px-2" : "h-control px-2.5"); }\nfunction B() { return "h-px"; }', "A"), ["h-7"]);
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
  if (!css) test(`${f} lets its controls take their height from their size`, () => assert.deepEqual(setHeights(text()), []));
  test(`${f} offers a choice through the app's Select`, () => assert.deepEqual(nativeSelects(text(), css), []));
  test(`${f} leaves focus to the one ring`, () => assert.deepEqual(ownFocusRings(text(), css, f === FOCUS_HOME), []));
}

for (const [f, component] of Object.entries(CONTROLS))
  test(`${f} stands every size at a control height`, () => assert.deepEqual(controlSizes(fs.readFileSync(path.join(APP, f), "utf8"), component), []));

test("the one ring is drawn from the focus token", () => {
  const home = code(fs.readFileSync(path.join(APP, FOCUS_HOME), "utf8"), true);
  assert.match(home, /(?:^|\})\s*:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-focus\);\s*outline-offset:\s*2px;\s*\}/);
});
