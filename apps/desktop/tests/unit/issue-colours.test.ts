// No issue state, label or person's disc is drawn amber: amber is what waits on the person
// (DESIGN.md, The One Voice Rule). Each preset has its own warn, from Clean Light's hue 57 as a
// screen draws it to Dracula's 113, and a colour within 32° of one can be taken for it: that is as
// near as a preset puts its own red or green to its warn (Clean Light's red is 32° from its warn
// as written, Solarized Dark's green 33°).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PRESETS } from "@hivemind/core/settings-schema";
import { cssColorToRgb } from "@hivemind/core/css-color";
import { nameHue } from "../../tools/issues/src/name-hue";

const NEAR = 32;

const linear = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };

/** The hues a colour shows: as written, for an oklch(), and as an sRGB screen draws it, which moves
 *  a colour the screen cannot show (Clean Light's warn, written at 62, is drawn at 57). None for a
 *  grey, under chroma 0.03 (Graphite's accent is 0.028): it has no hue to be taken for amber. */
function hues(css: string): number[] {
  const out: number[] = [];
  const written = /^oklch\(\s*[\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(css.trim());
  if (written && Number(written[1]) >= 0.03) out.push(Number(written[2]));
  const [r, g, b] = cssColorToRgb(css)!.map(linear) as [number, number, number];
  // sRGB to OKLab (Björn Ottosson's matrices).
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  if (Math.hypot(A, B) >= 0.03) out.push(((Math.atan2(B, A) * 180) / Math.PI + 360) % 360);
  return out;
}

const apart = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

const WARNS = Object.values(PRESETS).flatMap((p) => hues(p.palette.warn).map((h) => ({ id: p.id, h })));

/** The presets whose warn a colour is within NEAR of, and how near. */
const nearWarn = (css: string) =>
  hues(css).flatMap((h) => WARNS.filter((w) => apart(h, w.h) < NEAR).map((w) => `${w.id}'s warn ${apart(h, w.h).toFixed(1)}° away`));

/** The tokens as shipped: every block of the light page, and the rest, which is the dark page's. */
const CSS = fs.readFileSync(path.join(import.meta.dirname, "../../src/renderer/src/styles.css"), "utf8");
const LIGHT = [...CSS.matchAll(/:root\[data-theme-mode="light"\]\s*\{([^}]*)\}/g)].map((m) => m[1]!);
const DARK = LIGHT.reduce((css, block) => css.replace(block, ""), CSS);
const token = (block: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
const onPage = (name: string) => {
  const dark = token(DARK, name);
  assert.ok(dark, `--${name} is defined`);
  // Where several light blocks set it, the last wins, as in the cascade.
  return { dark, light: LIGHT.map((block) => token(block, name)).filter(Boolean).at(-1) ?? dark };
};

test("no issue state is drawn near a preset's warn, on the dark page or the light", () => {
  for (const s of ["backlog", "todo", "progress", "review", "done", "cancelled"])
    for (const [page, value] of Object.entries(onPage(`color-state-${s}`)))
      assert.deepEqual(nearWarn(value), [], `--color-state-${s} on the ${page} page is ${value}`);
});

test("no name's label or disc is drawn near a preset's warn, on the dark page or the light", () => {
  // Every name of one to three characters, small and capital letters, digits, "-", "_", "." and a
  // space: almost 300,000 names, whose character codes add up to anything from 32 to 366.
  const a = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. "];
  const names = a.flatMap((x) => [x, ...a.flatMap((y) => [x + y, ...a.map((z) => x + y + z)])]);
  const taken = new Map<number, string>();
  for (const n of names) if (!taken.has(nameHue(n))) taken.set(nameHue(n), n);
  // The text and dot of a label and a person's disc carry the name's hue; the chip's fill and edge
  // are tints under half opacity, grey as painted.
  for (const t of ["label-text", "label-dot", "person"])
    for (const [page, value] of Object.entries(onPage(`color-${t}`))) {
      const [, l, c] = /^oklch\(\s*([\d.]+)\s+([\d.]+)/.exec(value)!;
      for (const [h, n] of taken)
        assert.deepEqual(nearWarn(`oklch(${l} ${c} ${h})`), [], `"${n}" takes hue ${h}: its --color-${t} on the ${page} page`);
    }
});
