/**
 * A diff's colours, worked out from a look's palette: the syntax, the comment, the added, removed and
 * changed colours with their row tints and a changed word's highlight, and the line numbers. One
 * owner for three callers: the app paints them as `--color-syntax-*` and `--color-diff-*`
 * (theme-store), a theme is refused when one cannot be read on its page (theme-format), and the
 * desktop's test holds every built-in preset to the same pairs (tests/unit/diff-contrast.test.ts).
 *
 * The page is the palette's bg2; @pierre/diffs (apps/desktop pierre-codeview.ts) draws a changed row
 * as the page mixed in CIE Lab with a tint, a changed word as a translucent highlight over it, a
 * folded run's bar as the page mixed with white (black on a light page). `PIERRE_MIX` is how much of
 * the page each keeps, as Pierre 1.5.1's stylesheet says; the desktop's test reads the installed
 * stylesheet and fails when they differ.
 */
import { parseCssColor } from "./css-color.js";
import type { Palette } from "./settings-schema.js";

export type DiffMode = "dark" | "light";
type RGB = [number, number, number]; // sRGB, 0 to 1

/** How much of the page Pierre keeps under each tint, by mode. */
export const PIERRE_MIX = {
  /** A changed row (`[data-line]`), and the dark stripe of a removed line's hatched bar. */
  row: { dark: 0.8, light: 0.88 },
  /** A changed row's line number (`[data-column-number]`). */
  gutter: { dark: 0.85, light: 0.91 },
  /** A folded run's bar (`--diffs-bg-separator`), mixed with white on a dark page, black on a light. */
  separator: { dark: 0.85, light: 0.96 },
} as const;

/** The syntax colours, by mode: each keeps its hue at one OKLCH lightness, 0.82 on a dark page and
 *  0.45 on a light one, in the sRGB gamut. */
const SYNTAX: Record<DiffMode, Record<string, string>> = {
  dark: { keyword: "#d6b1ff", string: "#51e57c", number: "#feb251", function: "#9cc7ff", type: "#50dec9", property: "#99c8fe", tag: "#fea4cf" },
  light: { keyword: "#6f16b8", string: "#04663c", number: "#7b4702", function: "#064abb", type: "#015f77", property: "#0d4eb2", tag: "#9a035d" },
};

/** By mode: the lightness the added and removed words are held to (a preset's ok and err are drawn
 *  for a status mark, not for text), the lightness of a row's tint, and a changed word's highlight. */
const LOOK = {
  dark: { ink: (l: number) => Math.max(l, 0.78), tint: 0.5, word: 0.25, quiet: 0.7 },
  light: { ink: (l: number) => Math.min(l, 0.5), tint: 0.6, word: 0.2, quiet: 1 },
} as const;

// ── Colour arithmetic ──
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => { const e = Math.min(1, Math.max(0, c)); return e <= 0.0031308 ? 12.92 * e : 1.055 * e ** (1 / 2.4) - 0.055; };
const rgb = (css: string): RGB => {
  const c = parseCssColor(css);
  if (!c) throw new Error(`${css} is not a colour`);
  return c.rgb.map((x) => x / 255) as RGB;
};
const hex = (c: RGB, alpha?: number) => `#${[...c.map((x) => Math.round(x * 255)), ...(alpha === undefined ? [] : [Math.round(alpha * 255)])].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
const lum = (c: RGB) => { const [r, g, b] = c.map(lin) as RGB; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG 2 contrast of two colours. */
const contrast = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
/** The colour with its OKLCH lightness set, hue and chroma kept (CSS `oklch(from c L c h)`), clipped to sRGB. */
function withLightness(c: RGB, light: (l: number) => number): RGB {
  const [r, g, b] = c.map(lin) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return rgb(`oklch(${light(L)} ${Math.hypot(A, B)} ${((Math.atan2(B, A) * 180) / Math.PI + 360) % 360})`);
}
const toOklchL = (c: RGB) => {
  const [r, g, b] = c.map(lin) as RGB;
  return 0.2104542553 * Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) + 0.793617785 * Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) - 0.0040720468 * Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
};
// sRGB ↔ CIE Lab (D50, Bradford): the space `color-mix(in lab, …)` mixes in.
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
/** `color-mix(in lab, a keep, b)`. */
export const mixLab = (a: RGB, keep: number, b: RGB): RGB => { const A = toLab(a), B = toLab(b); return fromLab(A.map((v, i) => v * keep + B[i]! * (1 - keep)) as RGB); };
/** `ink` at `alpha` laid over `under`. */
const over = (under: RGB, ink: RGB, alpha: number) => under.map((v, i) => v * (1 - alpha) + ink[i]! * alpha) as RGB;

type DiffPalette = Pick<Palette, "bg2" | "bg3" | "fg" | "fg2" | "ok" | "err">;
type Side = "added" | "removed" | "changed";

/** Text 4.5:1; a mark (a bar's stripes, one against the other) 3:1 (apps/desktop/DESIGN.md). */
const TEXT = 4.5, MARK = 3;

/** What a diff draws on: the page, each changed row, word and line number's gutter, the Diff tile's
 *  header (bg3) and a folded run's bar. They follow from the palette and the tints alone. */
function grounds(p: DiffPalette, mode: DiffMode, tints: Record<Side, RGB>) {
  const page = rgb(p.bg2);
  const rows: Record<string, RGB> = { page };
  const gutter = {} as Record<Side, RGB>;
  for (const k of ["added", "removed", "changed"] as const) {
    const row = mixLab(page, PIERRE_MIX.row[mode], tints[k]);
    rows[`${k} row`] = row;
    rows[`${k} word`] = over(row, tints[k], LOOK[mode].word);
    gutter[k] = mixLab(page, PIERRE_MIX.gutter[mode], tints[k]);
  }
  const bar = mixLab(page, PIERRE_MIX.separator[mode], mode === "dark" ? [1, 1, 1] : [0, 0, 0]);
  return { page, rows, gutter, header: rgb(p.bg3), bar };
}

type Ground = { on: string; bg: RGB | ((ink: RGB) => RGB); least: number };
const lowest = (ink: RGB, on: Ground[]) => Math.min(...on.map((g) => contrast(ink, typeof g.bg === "function" ? g.bg(ink) : g.bg) / g.least));
/** The first of `candidates` (each further from the page than the last) that reads on all it is
 *  drawn on; the last when none does, which the check then names. */
const firstReading = (candidates: RGB[], on: Ground[]) => candidates.find((c) => lowest(c, on) >= 1) ?? candidates.at(-1)!;
const steps = (from: number, to: number) => Array.from({ length: Math.round(Math.abs(to - from) / 0.01) + 1 }, (_, i) => from + Math.sign(to - from) * i * 0.01);

interface Worked {
  text: RGB;
  syntax: Record<string, RGB>;
  /** A comment, a context row's line number, a folded run's words, the incoming side's numbers. */
  quiet: RGB;
  side: Record<Side, { ink: RGB; tint: RGB }>;
  /** Each ink and what it is drawn on, as the pairs list them. */
  drawn: [string, RGB, Ground[]][];
}

/** The diff's colours on this palette. Each starts at its own lightness (the syntax's, ok and err
 *  held to `LOOK.ink`, fg2 mixed toward fg) and moves away from the page only as far as every pair it
 *  is drawn in needs, so a built-in preset keeps them and a theme's page moves them. */
function work(p: DiffPalette, mode: DiffMode): Worked {
  const look = LOOK[mode];
  const fg = rgb(p.fg), fg2 = rgb(p.fg2);
  // Away from the page: toward white on a dark one, toward black on a light one, whatever the
  // mode says, so a palette with an odd page is moved the way that can read.
  const page = rgb(p.bg2);
  const lighter = contrast([1, 1, 1], page) >= contrast([0, 0, 0], page);
  const away = lighter ? 0.98 : 0.1;
  const toward = (from: number) => steps(from, lighter ? Math.max(from, away) : Math.min(from, away));
  const tints: Record<Side, RGB> = { added: withLightness(rgb(p.ok), () => look.tint), removed: withLightness(rgb(p.err), () => look.tint), changed: withLightness(fg2, () => look.tint) };
  const g = grounds(p, mode, tints);
  const onRows: Ground[] = Object.entries(g.rows).map(([on, bg]) => ({ on, bg, least: TEXT }));
  const drawn: Worked["drawn"] = [];
  const syntax: Record<string, RGB> = {};
  for (const [k, v] of Object.entries(SYNTAX[mode])) {
    const base = rgb(v);
    const at = toOklchL(base);
    syntax[k] = firstReading(toward(at).map((l) => withLightness(base, () => l)), onRows);
    drawn.push([k, syntax[k]!, onRows]);
  }
  // Quieter than text, as Pierre's own (fg at 65%) is; a preset's fg2 is drawn for the page (bg) and
  // reads less on a changed row, so it is mixed toward fg as far as it needs.
  const onQuiet: Ground[] = [...onRows, { on: "folded run's bar", bg: g.bar, least: TEXT }, { on: "changed gutter", bg: g.gutter.changed, least: TEXT }];
  // The diff's text is the palette's fg, moved too: a theme's fg may read at 4.5:1 on its page and
  // no more, and a changed row is lighter (darker, on a light page) than the page.
  const fgL = toOklchL(fg);
  const beyondFg = toward(fgL).map((l) => withLightness(fg, () => l));
  const text = firstReading(beyondFg, onRows);
  const quiet = firstReading([...steps(look.quiet, 0).map((k) => mixLab(fg2, k, fg)), ...beyondFg], onQuiet);
  drawn.push(["text", text, onRows], ["comment, line number", quiet, onQuiet]);
  const side = {} as Worked["side"];
  for (const k of ["added", "removed"] as const) {
    const base = rgb(k === "added" ? p.ok : p.err);
    const at = look.ink(toOklchL(base));
    // Its +N/−N on the page (a tool's diff) and on bg3 (the Diff tile's header), its line numbers on
    // their gutter; a removed line's bar is hatched in it and the page mixed with it, so the bar is
    // told from an added line's solid one without its colour.
    const on: Ground[] = [
      { on: "page", bg: g.page, least: TEXT }, { on: "Diff tile's header (bg3)", bg: g.header, least: TEXT }, { on: `${k} gutter`, bg: g.gutter[k], least: TEXT },
      ...(k === "removed" ? [{ on: "its bar's other stripe", bg: (ink: RGB) => mixLab(g.page, PIERRE_MIX.row[mode], ink), least: MARK }] : []),
    ];
    side[k] = { ink: firstReading(toward(at).map((l) => withLightness(base, () => l)), on), tint: tints[k] };
    drawn.push([`${k} count and line number`, side[k].ink, on]);
  }
  // The incoming side of a conflict is told by its tint and its "Incoming Change" line, not the
  // accent (DESIGN.md, the Accent Is Not a Signal Rule): its numbers in the quiet text.
  side.changed = { ink: quiet, tint: tints.changed };
  return { text, syntax, quiet, side, drawn };
}

/** The custom properties the app paints for a diff on this palette, as `#rrggbb` (or `#rrggbbaa`). */
export function diffColours(p: DiffPalette, mode: DiffMode): Record<string, string> {
  const w = work(p, mode);
  const out: Record<string, string> = { "--color-diff-text": hex(w.text) };
  for (const [k, c] of Object.entries(w.syntax)) out[`--color-syntax-${k}`] = hex(c);
  out["--color-syntax-comment"] = hex(w.quiet);
  out["--color-diff-number"] = hex(w.quiet);
  for (const [k, s] of Object.entries(w.side)) {
    out[`--color-diff-${k}`] = hex(s.ink);
    out[`--color-diff-${k}-tint`] = hex(s.tint);
    out[`--color-diff-${k}-word`] = hex(s.tint, LOOK[mode].word);
  }
  return out;
}

export interface DiffPair { ink: string; on: string; ratio: number; least: number }

/** Every pair a diff draws on this palette, with its contrast and the least it needs. */
export function diffPairs(p: DiffPalette, mode: DiffMode): DiffPair[] {
  return work(p, mode).drawn.flatMap(([ink, c, on]) => on.map((g) => ({ ink, on: g.on, ratio: contrast(c, typeof g.bg === "function" ? g.bg(c) : g.bg), least: g.least })));
}

/** The first pair a diff on this palette cannot be read in, in words; null when every pair holds. */
export function diffContrastProblem(p: DiffPalette, mode: DiffMode): string | null {
  const low = diffPairs(p, mode).find((x) => x.ratio < x.least);
  return low ? `a diff's ${low.ink} on its ${low.on} is ${(Math.floor(low.ratio * 100) / 100).toFixed(2)}:1; it needs at least ${low.least}:1` : null;
}
