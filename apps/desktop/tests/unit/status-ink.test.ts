/**
 * Status colours as the theme store paints them, in every built-in preset (apps/desktop/DESIGN.md):
 * a chip's word reads at 4.5:1 on its own opaque fill (16% of its colour over the panel colour,
 * whatever row is under it), its mark at 3:1 on a row at rest, under the pointer and selected
 * (`--surface-2/3/4`), a word drawn straight on those surfaces (`LOOKS[…].text`) at 4.5:1, and the
 * colour keeps its hue and at least half its chroma, so failed is still red. Glass cannot change
 * any of it: rows and headers paint the solid `--surface-*`, never the translucent `--color-bg*`.
 *
 * The settings store binds `window.hive` at import time, so the fake bridge and page go first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PRESETS, mergeSettings, setPath, type Settings } from "@hivemind/core/settings-schema";
import { contrastRatio, cssColorToOklab, cssColorToRgb } from "@hivemind/core/css-color";

let file: Settings = mergeSettings(DEFAULT_SETTINGS);
const props = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = () => 0;
(globalThis as unknown as Record<string, unknown>).document = {
  documentElement: {
    classList: { toggle() {} },
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    dataset: {},
    offsetHeight: 0,
  },
  head: { append() {} },
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "", append() {}, remove() {} }),
  createTextNode: () => ({}),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  hive: {
    settingsSync: () => file,
    settingsPatch: (p: { path: string; value: unknown }[]) => {
      file = mergeSettings(p.reduce((s, x) => setPath(s, x.path, x.value) as Settings, file));
      return Promise.resolve(file);
    },
    onSettingsChanged: () => () => {},
  },
};
const { chooseAccentColours, choosePreset } = await import("../../src/renderer/src/theme-store");
const { LOOKS } = await import("../../src/renderer/src/workspace/status-look");

/** A look's colour as the page resolves it: its `var(--token)` read from what the store painted. */
const painted = (color: string): string | undefined => {
  const token = /^var\((--[\w-]+)\)$/.exec(color)?.[1];
  return token ? props.get(token) : color;
};
/** `color-mix(in srgb, <c> 16%, <under>)`. */
const chipOn = (c: string, under: string): string => {
  const a = cssColorToRgb(c)!, b = cssColorToRgb(under)!;
  return `rgb(${a.map((x, i) => Math.round(x * 0.16 + b[i]! * 0.84)).join(" ")})`;
};
const chroma = (c: string) => { const [, a, b] = cssColorToOklab(c)!; return Math.hypot(a, b); };
const TONES = { failed: "err", needs: "warn" } as const;

test("failed, finished and needs-you read as chips, marks and words in every preset, and failed stays red", () => {
  const low: string[] = [];
  for (const [id, preset] of Object.entries(PRESETS)) {
    choosePreset(preset);
    const panel = props.get("--surface-2")!;
    for (const look of ["failed", "done", "needs"] as const) {
      const c = painted(LOOKS[look].color), text = painted(LOOKS[look].text);
      if (!c || !text) { low.push(`${id} ${look}: not painted`); continue; }
      const word = contrastRatio(c, chipOn(c, panel))!;
      if (word < 4.5) low.push(`${id} ${look}: chip word ${word.toFixed(2)}:1`);
      for (const row of ["--surface-2", "--surface-3", "--surface-4"]) {
        const under = props.get(row)!;
        const mark = contrastRatio(c, under)!, plain = contrastRatio(text, under)!;
        if (mark < 3) low.push(`${id} ${look} on ${row}: mark ${mark.toFixed(2)}:1`);
        if (plain < 4.5) low.push(`${id} ${look} on ${row}: word ${plain.toFixed(2)}:1`);
      }
      if (look in TONES) {
        const own = preset.palette[TONES[look as keyof typeof TONES]];
        if (chroma(c) < chroma(own) / 2) low.push(`${id} ${look}: chroma ${chroma(c).toFixed(3)} of ${chroma(own).toFixed(3)}`);
      }
    }
  }
  assert.deepEqual(low, []);
});

test("a picked accent's small marks read at 3:1 on the page, the panels and a header in every preset", () => {
  const low: string[] = [];
  for (const [id, preset] of Object.entries(PRESETS)) {
    choosePreset(preset);
    for (const brand of ["#7c6aa8", "#3b82f6", "#8a8a8a"]) {
      chooseAccentColours({ brand, accent: brand });
      const mark = props.get("--color-brand-mark")!;
      for (const on of [preset.palette.bg, props.get("--surface-2")!, props.get("--surface-3")!]) {
        const r = contrastRatio(mark, on)!;
        if (r < 3) low.push(`${id} ${brand} on ${on}: ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(low, []);
});
