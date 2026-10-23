/**
 * What the app tells a view of its theme (`readTheme`, sent in `hello.theme` and `theme`): every
 * colour of the frozen contract, resolved to #rrggbb from the app's own tokens. A view paints with
 * them and breaks silently when one stops coming (protocol `VIEW_THEME_COLORS`; removing one is a
 * Breaking change).
 *
 * The settings store binds `window.hive` at import time, so the fake bridge is installed first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "@hivemind/core/settings-schema";

/** The 15, as views have been told them since protocol 1.0. The literal is the contract. */
const FROZEN = ["bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent"];

(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  hive: { settingsSync: () => DEFAULT_SETTINGS, settingsPatch: () => Promise.resolve(DEFAULT_SETTINGS), onSettingsChanged: () => () => {} },
};
// The page's tokens: every --color-* the stylesheet has, each set.
const tokens = new Map([...FROZEN, "select", "terminal-bg", "status-working"].map((k, i) => [`--color-${k}`, `rgb(${i}, 0, 0)`]));
// theme-store paints the page once on import.
(globalThis as unknown as { document: unknown }).document = { documentElement: { classList: { toggle() {} }, dataset: {}, style: { setProperty() {} } } };
(globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({ getPropertyValue: (k: string) => tokens.get(k) ?? "" });
const { readTheme } = await import("../../src/renderer/src/workspace/plugin-theme");

test("a view is told every frozen colour the page has, each as #rrggbb", () => {
  const { colors } = readTheme();
  // The resolution to hex is css-color's (a canvas, absent here); what is sent is the contract.
  assert.deepEqual(FROZEN.filter((k) => !/^#[0-9a-f]{6}$/.test(colors[k] ?? "")), []);
});
