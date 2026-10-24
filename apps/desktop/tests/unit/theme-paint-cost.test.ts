/**
 * What a repaint of the theme works out again (CLAUDE.md, "Work that runs per event"). A slider in
 * Settings ▸ Appearance repaints the theme on every pointer move, and the accent picker on every
 * input event, each through a settings write that rebuilds the palette's object. A diff's colours
 * (core's `diffColours`) and the status inks (`statusInk`, `statusTextInk`) take a millisecond or
 * more each, so they are worked out again only when a value they read changes. Each test compares a
 * move with the work it must not redo, measured in the same run, so the machine's speed cancels out.
 *
 * The settings store binds `window.hive` at import time, so the fake bridge and page go first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PRESETS, mergeSettings, setPath, type Settings } from "@hivemind/core/settings-schema";
import { diffColours } from "@hivemind/core/diff-colours";
import { UNREAD_BLUE, statusInk, statusTextInk } from "@hivemind/core/theme-format";

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
const { chooseAccentColours, choosePreset, getTheme, setTheme } = await import("../../src/renderer/src/theme-store");

const N = 40;
/** Mean milliseconds of `fn(i)` over N runs, after one to warm up. */
function mean(fn: (i: number) => void): number {
  fn(-1);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn(i);
  return (performance.now() - t0) / N;
}

test("a slider move does not work a diff's colours out again: it costs under half of doing so", () => {
  for (const preset of [PRESETS.signal!, PRESETS["clean-light"]!, PRESETS.nord!]) {
    choosePreset(preset);
    const move = mean((i) => setTheme({ blur: 8 + (i % 8) }));
    const { palette, mode } = getTheme();
    const diff = mean(() => diffColours(palette, mode));
    assert.ok(move < diff / 2, `${preset.label}: a slider move took ${move.toFixed(3)} ms, a diff's colours ${diff.toFixed(3)} ms`);
  }
});

test("a move in the accent picker works out only the accent's mark, not the six status inks", () => {
  // Nord's failed and needs-you are fitted (Signal's already read as they are, which costs little).
  choosePreset(PRESETS.nord!);
  const brand = (i: number) => `oklch(0.62 0.15 ${(i * 7) % 360})`;
  const move = mean((i) => chooseAccentColours({ brand: brand(i), accent: brand(i) }));
  const { palette: p } = getTheme();
  const inks = mean(() => {
    for (const c of [p.err, p.warn, UNREAD_BLUE]) { statusInk(c, p); statusTextInk(c, p); }
  });
  assert.ok(move < inks / 2, `an accent move took ${move.toFixed(3)} ms, the six status inks ${inks.toFixed(3)} ms`);
});
