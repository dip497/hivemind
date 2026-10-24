/**
 * A status chip on a selected or hovered row (Layers, Home, the slot bar) in every built-in preset,
 * glass on and off: its word reads at 4.5:1 on its own 16% fill and its mark at 3:1 on the row
 * (apps/desktop/DESIGN.md). The colours are the ones the theme store paints for the look's token,
 * and the rows are the solid surfaces a selected (`--surface-4`) and a hovered (`--surface-3`) row
 * take, glass or not.
 *
 * The settings store binds `window.hive` at import time, so the fake bridge and page go first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PRESETS, mergeSettings, setPath, type Settings } from "@hivemind/core/settings-schema";
import { contrastRatio, cssColorToRgb } from "@hivemind/core/css-color";

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
const { choosePreset, setTheme } = await import("../../src/renderer/src/theme-store");
const { LOOKS } = await import("../../src/renderer/src/workspace/status-look");

/** A look's colour as the page resolves it: its `var(--token)` read from what the store painted. */
const painted = (color: string): string | undefined => {
  const token = /^var\((--[\w-]+)\)$/.exec(color)?.[1];
  return token ? props.get(token) : color;
};
/** `color-mix(in srgb, <c> 16%, transparent)` over an opaque row. */
const chipOn = (c: string, row: string): string => {
  const a = cssColorToRgb(c)!, b = cssColorToRgb(row)!;
  return `rgb(${a.map((x, i) => Math.round(x * 0.16 + b[i]! * 0.84)).join(" ")})`;
};

test("failed, finished and needs-you chips read on a selected and a hovered row in every preset, glass on and off", () => {
  const low: string[] = [];
  for (const [id, preset] of Object.entries(PRESETS)) {
    for (const glass of [false, true]) {
      choosePreset(preset);
      setTheme({ glass, wallpaper: glass ? "aurora" : "none" });
      for (const [row, surface] of [["selected", "--surface-4"], ["hovered", "--surface-3"]] as const) {
        const under = props.get(surface)!;
        for (const look of ["failed", "done", "needs"] as const) {
          const c = painted(LOOKS[look].color);
          if (!c) { low.push(`${id} ${look}: ${LOOKS[look].color} is not painted`); continue; }
          const word = contrastRatio(c, chipOn(c, under))!, mark = contrastRatio(c, under)!;
          if (word < 4.5 || mark < 3) low.push(`${id}${glass ? " glass" : ""} ${row} ${look}: word ${word.toFixed(2)}:1, mark ${mark.toFixed(2)}:1`);
        }
      }
    }
  }
  assert.deepEqual(low, []);
});
