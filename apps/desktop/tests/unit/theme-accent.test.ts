/**
 * The accent from the renderer (theme-store): a colour the person picks is kept in
 * `appearanceExtra.accent`, a built-in accent or a preset removes it (a preset the record of a
 * theme too), and the accent's marks (`html.accent-marks`: the primary button, the focus ring, a
 * switch that is on) follow a custom accent or a theme, never a preset with a built-in id.
 *
 * The settings store binds `window.hive` at import time, so the fake bridge and page go first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APPEARANCE, DEFAULT_SETTINGS, PRESETS, mergeSettings, setPath, type Settings } from "@hivemind/core/settings-schema";

const record = { id: "@acme/looks/harbour", name: "Harbour", version: "1.0.0", appliedAt: 1, before: { appearance: DEFAULT_APPEARANCE, extra: {} }, set: ["appearance.palette"] };
/** settings.json as main keeps it: each patch the window sends applied to it. */
let file: Settings = mergeSettings({ ...DEFAULT_SETTINGS, appearanceExtra: { theme: record } });
const sent: { path: string; value: unknown }[][] = [];

/** The page as theme-store paints it: the root's classes and custom properties. */
const classes = new Set<string>();
const props = new Map<string, string>();
const el = () => ({ id: "", textContent: "", append() {}, remove() {} });
(globalThis as unknown as Record<string, unknown>).requestAnimationFrame = () => 0;
(globalThis as unknown as Record<string, unknown>).document = {
  documentElement: {
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    dataset: {},
    offsetHeight: 0,
  },
  head: { append() {} },
  getElementById: () => null,
  createElement: el,
  createTextNode: () => ({}),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  hive: {
    settingsSync: () => file,
    settingsPatch: (p: { path: string; value: unknown }[]) => {
      sent.push(p);
      file = mergeSettings(p.reduce((s, x) => setPath(s, x.path, x.value) as Settings, file));
      return Promise.resolve(file);
    },
    onSettingsChanged: () => () => {},
  },
};
const { applyTheme, chooseAccent, chooseAccentColours, choosePreset, getTheme } = await import("../../src/renderer/src/theme-store");
const { getSettings } = await import("../../src/renderer/src/settings-store");

const WOOD = { brand: "#b07a4f", accent: "#c99a72" };
const marks = () => { applyTheme(); return classes.has("accent-marks"); };
/** What the window's next write sent, once its debounce has run. */
const written = async () => { await new Promise((r) => setTimeout(r, 300)); return new Map(sent.at(-1)!.map((p) => [p.path, p.value])); };

test("a theme's accent has marks; a picked colour is kept beside the id and has marks", async () => {
  assert.equal(marks(), true);
  chooseAccentColours(WOOD);
  assert.deepEqual(getSettings().appearanceExtra.accent, WOOD);
  assert.deepEqual([...(await written())], [["appearanceExtra.accent", WOOD]]);
  assert.equal(marks(), true);
  assert.equal(props.get("--color-brand"), WOOD.brand);
  assert.ok(props.has("--color-brand-fg"));
});

test("a preset removes the custom accent and the theme's record, and its built-in accent has no marks", async () => {
  chooseAccentColours(WOOD);
  choosePreset(PRESETS.nord!);
  assert.equal(getSettings().appearanceExtra.accent, undefined);
  assert.equal(getSettings().appearanceExtra.theme, undefined);
  const paths = await written();
  assert.ok(paths.has("appearanceExtra.accent") && paths.get("appearanceExtra.accent") === undefined);
  assert.ok(paths.has("appearanceExtra.theme") && paths.get("appearanceExtra.theme") === undefined);
  assert.equal(marks(), false);
  assert.equal(props.has("--color-brand-fg"), false);
});

test("a built-in accent picked over a custom one removes it: the id paints, without marks", async () => {
  chooseAccentColours(WOOD);
  assert.equal(marks(), true);
  chooseAccent("ember");
  assert.equal(getSettings().appearanceExtra.accent, undefined);
  assert.equal((await written()).get("appearance.accent"), "ember");
  assert.equal(file.appearanceExtra.accent, undefined);
  assert.equal(getTheme().accentCustom, undefined);
  assert.equal(marks(), false);
});
