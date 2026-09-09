/**
 * The 2.0 surface policy (theme-store): the user's theme wins everywhere, and
 * the wallpaper under a plugin scene is painted per docked slot, not
 * full-window. `pluginSurfaces: "opaque"` opts back out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveGlass, getTheme, getSurfacePolicy, setTheme, setWallpaperActive, slotWallpaper } from "../../src/renderer/src/theme-store";

const reset = () => { setWallpaperActive(true); setTheme({ glass: true, wallpaper: "aurora", pluginSurfaces: "theme" }); };

test("surface snapshot changes with the view gate even when the theme identity is unchanged", () => {
  reset();
  setTheme({ pluginSurfaces: "opaque" });
  const theme = getTheme();
  const canvas = getSurfacePolicy();
  assert.equal(getSurfacePolicy(), canvas);
  setWallpaperActive(false);
  assert.equal(getTheme(), theme);
  assert.notEqual(getSurfacePolicy(), canvas);
  assert.deepEqual(getSurfacePolicy(), { glass: false, slotWallpaper: false });
  setWallpaperActive(true);
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
