// A diff (pierre-codeview.ts) draws on the preset's bg2, in the app's syntax colours. Every word
// in it reads at 4.5:1 (DESIGN.md) on every built-in preset, dark and light: each syntax colour,
// a comment and plain text on the page, on an added, removed or conflicting row's tint and on a
// changed word's highlight over it; the +N and −N counts on the page, and a changed row's line
// number on its gutter's tint.
//
// The colours are the tokens styles.css ships, worked out as the browser does: `oklch(from …)`
// and `color-mix(in lab, …)` on the preset's palette, a row mixed with its tint in CIE Lab in the
// proportions Pierre's own stylesheet sets (read from the installed @pierre/diffs), a word's
// translucent highlight laid over the row in sRGB.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ACCENTS, PRESETS, type ThemePreset } from "@hivemind/core/settings-schema";
import { parseCssColor } from "@hivemind/core/css-color";

type RGB = [number, number, number]; // sRGB, 0 to 1
type Mode = "dark" | "light";

// ── The tokens as shipped: every light block, and the rest, which is the dark page's. ──
const CSS = fs.readFileSync(path.join(import.meta.dirname, "../../src/renderer/src/styles.css"), "utf8");
const LIGHT = [...CSS.matchAll(/:root\[data-theme-mode="light"\]\s*\{([^}]*)\}/g)].map((m) => m[1]!);
const DARK = LIGHT.reduce((css, block) => css.replace(block, ""), CSS);
const declared = (block: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
function token(mode: Mode, name: string): string {
  const dark = declared(DARK, name);
  assert.ok(dark, `--${name} is defined`);
  return mode === "dark" ? dark : (LIGHT.map((b) => declared(b, name)).filter(Boolean).at(-1) ?? dark);
}
const SYNTAX = [...new Set([...DARK.matchAll(/--(color-syntax-[a-z]+):/g)].map((m) => m[1]!))];

// ── Pierre's mix of the page with a changed row's tint, from the stylesheet the app loads. ──
const pierreCss = fs.readFileSync(path.join(import.meta.dirname, "../../node_modules/@pierre/diffs/dist/style.js"), "utf8");
function pierreMix(selector: string): Record<Mode, number> {
  const at = pierreCss.indexOf(`${selector}{--mix-light:`);
  assert.ok(at >= 0, `Pierre mixes ${selector} with its tint`);
  const [, light, dark] = /--mix-light:(\d+)%;--mix-dark:(\d+)%/.exec(pierreCss.slice(at))!;
  return { light: Number(light) / 100, dark: Number(dark) / 100 };
}
const ROW = pierreMix("& [data-line],& [data-no-newline]");
const GUTTER = pierreMix("& [data-gutter-buffer],& [data-column-number]");

// ── Colour arithmetic. ──
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => { const e = Math.min(1, Math.max(0, c)); return e <= 0.0031308 ? 12.92 * e : 1.055 * e ** (1 / 2.4) - 0.055; };
const lum = (c: RGB) => { const [r, g, b] = c.map(lin) as RGB; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
function oklchOf(c: RGB): [number, number, number] {
  const [r, g, b] = c.map(lin) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
// sRGB ↔ CIE Lab (D50, Bradford), the space `color-mix(in lab, …)` mixes in.
const D50 = [0.96422, 1, 0.82521];
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const fInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
function toLab(c: RGB): RGB {
  const [r, g, b] = c.map(lin) as RGB;
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b, Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b, Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const [x, y, z] = [1.0479298 * X + 0.0229468 * Y - 0.0501922 * Z, 0.0296278 * X + 0.9904344 * Y - 0.0170738 * Z, -0.009243 * X + 0.0150552 * Y + 0.7518743 * Z].map((v, i) => f(v / D50[i]!)) as RGB;
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function fromLab([L, a, b]: RGB): RGB {
  const fy = (L + 16) / 116;
  const [X, Y, Z] = [fInv(fy + a / 500) * D50[0]!, L > 8 ? fy ** 3 : L / (24389 / 27), fInv(fy - b / 200) * D50[2]!];
  const [x, y, z] = [0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z, -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z, 0.0122982 * X - 0.020483 * Y + 1.3299098 * Z];
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z].map(gam) as RGB;
}
const mixLab = (a: RGB, p: number, b: RGB): RGB => { const A = toLab(a), B = toLab(b); return fromLab(A.map((v, i) => v * p + B[i]! * (1 - p)) as RGB); };
const over = (under: RGB, ink: RGB, alpha: number) => under.map((v, i) => v * (1 - alpha) + ink[i]! * alpha) as RGB;

interface Paint { rgb: RGB; alpha: number }
const N = String.raw`([\d.]+)`;
/** A token as the browser computes it on a page painted with this preset: the forms styles.css
 *  uses for a diff, and nothing else, so a token written another way fails here until it is. */
function paint(css: string, p: ThemePreset, mode: Mode): Paint {
  const v = css.trim();
  const ref = /^var\(--color-([a-z0-9-]+)\)$/.exec(v)?.[1];
  if (ref) {
    if (ref in p.palette) return paint(p.palette[ref as keyof typeof p.palette], p, mode);
    if (ref === "brand") return paint(ACCENTS[p.accent].brand, p, mode);
    return paint(token(mode, `color-${ref}`), p, mode);
  }
  const rel = new RegExp(String.raw`^oklch\(from var\(--color-([a-z]+)\) (?:(max|min)\(l, ${N}\)|${N}) c h(?: / ${N})?\)$`).exec(v);
  if (rel) {
    const [, of, fn, bound, fixed, alpha] = rel;
    const [l, c, h] = oklchOf(paint(`var(--color-${of})`, p, mode).rgb);
    const L = fixed ? Number(fixed) : fn === "max" ? Math.max(l, Number(bound)) : Math.min(l, Number(bound));
    return { rgb: parseCssColor(`oklch(${L} ${c} ${h})`)!.rgb.map((x) => x / 255) as RGB, alpha: alpha ? Number(alpha) : 1 };
  }
  const mix = new RegExp(String.raw`^color-mix\(in lab, (var\([^)]+\)) ${N}%, (var\([^)]+\))\)$`).exec(v);
  if (mix) return { rgb: mixLab(paint(mix[1]!, p, mode).rgb, Number(mix[2]) / 100, paint(mix[3]!, p, mode).rgb), alpha: 1 };
  const solid = parseCssColor(v);
  assert.ok(solid && !solid.alpha, `${v} is a colour this test can paint`);
  return { rgb: solid.rgb.map((x) => x / 255) as RGB, alpha: 1 };
}

const LEAST = 4.5;

/** Every pair a diff draws on this preset, with its contrast. */
function table(p: ThemePreset) {
  const mode = p.mode;
  const solid = (name: string) => paint(`var(--color-${name})`, p, mode).rgb;
  const page = solid("bg2");
  const rows: Record<string, RGB> = { page };
  for (const [side, word] of [["added", true], ["removed", true], ["changed", false]] as const) {
    const row = mixLab(page, ROW[mode], solid(`diff-${side}-tint`));
    rows[`${side} row`] = row;
    if (word) { const w = paint(`var(--color-diff-${side}-word)`, p, mode); rows[`${side} word`] = over(row, w.rgb, w.alpha); }
  }
  const inks: Record<string, RGB> = { text: solid("fg"), ...Object.fromEntries(SYNTAX.map((s) => [s.slice("color-".length), solid(s.slice("color-".length))])) };
  const pairs: { ink: string; on: string; ratio: number }[] = [];
  for (const [ink, c] of Object.entries(inks)) for (const [on, bg] of Object.entries(rows)) pairs.push({ ink, on, ratio: contrast(c, bg) });
  for (const side of ["added", "removed"]) {
    const ink = solid(`diff-${side}`);
    pairs.push({ ink: `${side} count`, on: "page", ratio: contrast(ink, page) });
    pairs.push({ ink: `${side} line number`, on: `${side} gutter`, ratio: contrast(ink, mixLab(page, GUTTER[mode], solid(`diff-${side}-tint`))) });
  }
  return pairs;
}

test("Pierre's changed rows mix in the proportions this test assumes are its own", () => {
  // Read, not assumed: a Pierre that mixed in other proportions moves every row below.
  assert.ok(ROW.dark > 0.5 && ROW.dark < 1 && ROW.light > 0.5 && ROW.light < 1, JSON.stringify(ROW));
  assert.ok(SYNTAX.length >= 8 && SYNTAX.includes("color-syntax-comment"), SYNTAX.join(", "));
});

for (const p of Object.values(PRESETS)) {
  test(`every word in a diff reads at ${LEAST}:1 on ${p.label} (${p.mode})`, () => {
    const low = table(p).filter((x) => x.ratio < LEAST).map((x) => `${x.ink} on the ${x.on}: ${x.ratio.toFixed(2)}:1`);
    assert.deepEqual(low, []);
  });
}
