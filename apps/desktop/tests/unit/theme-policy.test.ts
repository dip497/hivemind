/**
 * The 2.0 surface policy (theme-store): the user's theme wins everywhere, and
 * the wallpaper under a plugin scene is painted per docked slot, not
 * full-window. `pluginSurfaces: "opaque"` opts back out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSettings, patchSettingsMany } from "../../src/renderer/src/settings-store";
import { effectiveGlass, getTheme, getSurfacePolicy, setPluginScene, setTheme, setWallpaperActive, slotWallpaper, wallpaperDrawn } from "../../src/renderer/src/theme-store";

// Two gates, not one: whether the view paints the full-window wallpaper, and whether a plugin
// draws it. A plugin view gets the wallpaper too, so "opaque" keys off the second.
const reset = () => { setWallpaperActive(true); setPluginScene(false); setTheme({ glass: true, wallpaper: "aurora", pluginSurfaces: "theme" }); };

test("surface snapshot changes with the view gate even when the theme identity is unchanged", () => {
  reset();
  setTheme({ pluginSurfaces: "opaque" });
  const theme = getTheme();
  const canvas = getSurfacePolicy();
  assert.equal(getSurfacePolicy(), canvas);
  setPluginScene(true);
  assert.equal(getTheme(), theme);
  assert.notEqual(getSurfacePolicy(), canvas);
  assert.deepEqual(getSurfacePolicy(), { glass: false, slotWallpaper: false });
  setPluginScene(false);
  assert.equal(getSurfacePolicy(), canvas);
  reset();
});

test("under an arranging view the full-window wallpaper paints and no slot layer does", () => {
  reset();
  assert.equal(effectiveGlass(getTheme()), true);
  assert.equal(slotWallpaper(getTheme()), false);
});

test('in a plugin scene, "theme" keeps glass and paints the wallpaper per slot', () => {
  reset();
  setWallpaperActive(false);
  assert.equal(effectiveGlass(getTheme()), true);
  assert.equal(slotWallpaper(getTheme()), true);
});

test('"opaque" restores the cheap behaviour: no glass, no wallpaper in a scene', () => {
  reset();
  setWallpaperActive(false);
  setPluginScene(true);
  setTheme({ pluginSurfaces: "opaque" });
  assert.equal(effectiveGlass(getTheme()), false);
  assert.equal(slotWallpaper(getTheme()), false);
});

test("a theme with glass off or no wallpaper never costs a slot layer", () => {
  reset();
  setWallpaperActive(false);
  setTheme({ glass: false });
  assert.equal(slotWallpaper(getTheme()), false);
  setTheme({ glass: true, wallpaper: "none" });
  assert.equal(slotWallpaper(getTheme()), false);
  reset();
});

test("a theme's wallpaper draws without glass, and glass stays off: it is the person's", () => {
  reset();
  // A theme is applied by main (theme-apply.ts); the window hears its record in the settings.
  patchSettingsMany([{ path: "appearanceExtra.theme", value: { id: "@acme/looks/harbour", name: "Harbour", version: "1.0.0", appliedAt: 1, before: { appearance: getSettings().appearance, extra: {} } } }]);
  setTheme({ glass: false });
  assert.equal(wallpaperDrawn(getTheme()), true);
  assert.equal(effectiveGlass(getTheme()), false);
  // In a plugin scene it is painted per slot, as a wallpaper behind glass is.
  setWallpaperActive(false);
  assert.equal(slotWallpaper(getTheme()), true);
  // Without a theme, glass off still means no wallpaper (the presets look as they did).
  patchSettingsMany([{ path: "appearanceExtra.theme", value: undefined }]);
  assert.equal(wallpaperDrawn(getTheme()), false);
  assert.equal(slotWallpaper(getTheme()), false);
  // Except Shoal, which pictures the agents: it shows without glass, solid panels over it, and with
  // glass on the panels frost over it as over any other background.
  setTheme({ wallpaper: "shoal" });
  assert.equal(wallpaperDrawn(getTheme()), true);
  assert.equal(effectiveGlass(getTheme()), false);
  setTheme({ glass: true });
  assert.equal(wallpaperDrawn(getTheme()), true);
  assert.equal(effectiveGlass(getTheme()), true);
  reset();
});
