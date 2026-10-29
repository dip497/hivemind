/**
 * Which way round a look is, and each live scene's water in its own colours: for the page, where
 * the wallpaper layer shows it till the scene draws and where it does not run, and Settings'
 * swatches; and for the check that the frosted panels' text reads over it (live-palette.test.ts).
 * The scenes' palettes themselves are each scene's own (shoal/palette.ts …).
 */
import type { LiveSceneId } from "@hivemind/core/settings-schema";
import type { WaterLook } from "./backdrop";
import { css, rgbOf } from "./colour";
import { JELLY_PALETTE } from "./jelly/palette";
import { KOI_PALETTE } from "./koi/palette";
import { SHOAL_PALETTE } from "./shoal/palette";

const luma = (c: number) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);

/** A light theme: its page (0xRRGGBB) is lighter than its text. A scene draws its light palette. */
export const lightOf = (page: number, text: number) => luma(page) > luma(text);

/** Each scene's water, on a dark theme and a light one. */
export const WATERS: Record<LiveSceneId, { dark: WaterLook; light: WaterLook }> = {
  shoal: SHOAL_PALETTE,
  koi: KOI_PALETTE,
  jellyfish: JELLY_PALETTE,
};

/** The characters of a scene's swatch in Settings over its water: pale on dark water, deep on
 *  light, in the water's own hue. */
export function swatchInk(scene: LiveSceneId, light: boolean): string {
  const h = WATERS[scene][light ? "light" : "dark"].water[0]![2];
  return css(rgbOf(light ? [0.34, 0.05, h] : [0.93, 0.03, h]));
}

/** The scene's water as a CSS gradient. */
export function waterCss(scene: LiveSceneId, light: boolean): string {
  const stops = WATERS[scene][light ? "light" : "dark"].water;
  return `linear-gradient(to bottom, ${stops.map((c) => css(rgbOf(c))).join(", ")})`;
}
