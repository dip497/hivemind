/**
 * A joined workspace in its host's look (theme-store `showHostLook`): the window paints the host's
 * theme in the person's own fonts, an edit made meanwhile is to the person's own theme and is
 * saved as theirs, and leaving shows their own again.
 *
 * The settings store binds `window.hive` at import time, so the fake bridge is installed first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, mergeSettings, sharedAppearance, type Settings } from "@hivemind/core/settings-schema";

const file: Settings = mergeSettings({ ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, preset: "mine", accent: "emerald", uiFont: "My Sans" } });
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  hive: {
    settingsSync: () => file,
    settingsPatch: () => Promise.resolve(file),
    onSettingsChanged: () => () => {},
  },
};
const { getTheme, setTheme, showHostLook } = await import("../../src/renderer/src/theme-store");
const { getSettings } = await import("../../src/renderer/src/settings-store");

test("a host's workspace shows its look in the person's own fonts; edits stay the person's; leaving shows theirs", () => {
  const own = getTheme();
  showHostLook(sharedAppearance({ ...DEFAULT_SETTINGS.appearance, preset: "nord", accent: "ice", mode: "light" }));
  assert.deepEqual([getTheme().preset, getTheme().accent, getTheme().mode, getTheme().uiFont], ["nord", "ice", "light", "My Sans"]);

  setTheme({ blur: 20 });
  // The host's look is still what is shown; the settings saved are the person's own, edited.
  assert.equal(getTheme().preset, "nord");
  const mine = getSettings().appearance;
  assert.deepEqual([mine.preset, mine.accent, mine.mode, mine.glass.blur], ["mine", "emerald", "dark", 20]);

  showHostLook(null);
  assert.deepEqual({ ...getTheme(), blur: own.blur }, own);
  assert.equal(getTheme().blur, 20);
});
