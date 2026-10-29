/**
 * A live scene in its own colours (live/palette): the Layers panel over it is clear glass, as
 * little as a sixth of its tint with See-through, so the panel's text reads only if the scene's
 * water is dark enough on a dark theme and light enough on a light one, everywhere, under the glow
 * and a light shaft at their brightest too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "@hivemind/core/settings-schema";
import { contrast, rgbOf, type Rgb } from "../../src/renderer/src/live/colour";
import { WATERS } from "../../src/renderer/src/live/palette";
import { SEE_THROUGH } from "../../src/renderer/src/theme-store";

const parse = (s: string): Rgb => {
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(s);
  assert.ok(m, s);
  return rgbOf([Number(m[1]), Number(m[2]), Number(m[3])]);
};
/** `top` at `alpha` over `under`, as the page composites it. */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => v * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;
const add = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => Math.min(255, under[i]! + v * alpha)) as unknown as Rgb;
/** The panel over a live scene: the panel colour at a third of the glass opacity (styles.css). */
const TINT = SEE_THROUGH.opacity! / 3;

test("each scene's water keeps the frosted panel's text legible over it, on a dark theme and a light one", () => {
  for (const [scene, looks] of Object.entries(WATERS)) {
    for (const [mode, preset] of [["dark", "signal"], ["light", "clean-light"]] as const) {
      const look = looks[mode];
      const { bg2, fg, fg2, fg3 } = PRESETS[preset]!.palette;
      const stops = look.water.map(rgbOf);
      const glowed = look.glow ? over(rgbOf(look.glow.colour), look.glow.alpha, stops[0]!) : stops[0]!;
      const shaft = look.shafts && (look.shafts.add ? add : over)(rgbOf(look.shafts.colour), look.shafts.alpha, glowed);
      const still = [...stops, glowed];
      for (const [i, water] of [...still, ...(shaft ? [shaft] : [])].entries()) {
        const where = `${scene} ${mode}, ${i < stops.length ? `water stop ${i}` : i === stops.length ? "the glow" : "a shaft"}`;
        const panel = over(parse(bg2), TINT, water);
        assert.ok(contrast(parse(fg), panel) >= 7, `${where}: text ${contrast(parse(fg), panel).toFixed(2)}`);
        assert.ok(contrast(parse(fg2), panel) >= 4.5, `${where}: secondary text ${contrast(parse(fg2), panel).toFixed(2)}`);
        // The faintest text, a hint, over the still water; a shaft passes.
        if (i < still.length) assert.ok(contrast(parse(fg3), panel) >= 3, `${where}: hint ${contrast(parse(fg3), panel).toFixed(2)}`);
      }
    }
  }
});
