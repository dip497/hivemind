/**
 * The look every scene draws in. In the theme's colours, each tone is a step from its page colour
 * to its text colour, worked out once per theme so a frame builds no colour strings, on the page
 * with a faint cell grid. In the scene's own colours (Colour on), its palette: the water it paints
 * (backdrop.ts) and whatever else the scene takes from it (`styled`).
 */
import { paintWater, Shafts, waterOf, type Water, type WaterLook } from "./backdrop";
import { CellRenderer, paintGrid } from "./cells";
import { RAMP } from "./colour";
import { clamp } from "./math";
import { lightOf } from "./palette";
import type { Look } from "./scene";

/** The grid over the page, as a tone: fainter on a light page, where ink shows more. */
const GRID = { light: 0.015, dark: 0.055 };

/** RAMP + 1 steps from the page (0xRRGGBB) to the text, as fill styles and as pixels (ImageData's
 *  RGBA, little-endian). Each channel moves at its weight: a weight over 1 casts the steps toward
 *  that channel. */
export function themeRamp(page: number, text: number, [wr, wg, wb]: readonly number[] = [1, 1, 1]) {
  const ch = (c: number, k: number) => (c >> k) & 255;
  const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  const styles: string[] = [];
  const pixels = new Uint32Array(RAMP + 1);
  for (let i = 0; i <= RAMP; i++) {
    const t = i / RAMP;
    const mix = (k: number, w: number) => clamp(Math.round(ch(page, k) + (ch(text, k) - ch(page, k)) * t * w), 0, 255);
    const [r, g, b] = [mix(16, wr!), mix(8, wg!), mix(0, wb!)];
    styles.push(hex((r << 16) | (g << 8) | b));
    pixels[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return { styles, pixels };
}

export abstract class LookRenderer<P extends WaterLook> extends CellRenderer {
  /** The page is lighter than the text. */
  protected light = false;
  /** The theme's page and text colours, as 0xRRGGBB. */
  protected page = 0x000000;
  protected text = 0xffffff;
  /** The page to the text (`themeRamp`), or a scene's own ramp in colour (`styled`). */
  protected ramp: string[] = [];
  /** The scene's own colours, when it is drawn in them. */
  protected colour: P | null = null;
  private water: Water | null = null;
  private shafts = new Shafts();

  constructor(canvas: OffscreenCanvas, private palettes: { dark: P; light: P }) {
    super(canvas);
  }

  /** The theme's page and text colours, and whether the scene is drawn in its own instead. */
  setLook(look: Look) {
    this.page = look.page;
    this.text = look.text;
    this.light = lightOf(look.page, look.text);
    this.ramp = themeRamp(look.page, look.text).styles;
    this.colour = look.colour ? this.palettes[this.light ? "light" : "dark"] : null;
    this.water = this.colour && waterOf(this.colour);
    this.shafts.setLook(this.water?.shafts ?? null);
    this.styled();
    if (this.cols) this.repaintBackground();
  }

  /** The look changed (`light`, `ramp`, `colour`): the scene works out its styles. */
  protected abstract styled(): void;

  /** The step `t` (0 page … 1 text) of a ramp, the plain one by default. */
  protected tone(t: number, ramp = this.ramp) {
    return ramp[clamp(Math.round(t * RAMP), 0, RAMP)]!;
  }

  resize(width: number, height: number, dpr: number) {
    super.resize(width, height, dpr);
    this.shafts.resize(width, height);
  }

  protected paintBackground() {
    const g = this.bg.getContext("2d");
    if (!g) return;
    const { width: W, height: H, dpr, cw, ch } = this;
    if (this.water) {
      paintWater(g, W, H, cw, ch, dpr, this.water);
      return;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.tone(0);
    g.fillRect(0, 0, W, H);
    paintGrid(g, W, H, cw, ch, dpr, this.tone(this.light ? GRID.light : GRID.dark));
  }

  /** What a frame starts from at time `t`: the backdrop, with the light shafts over it in colour. */
  protected backdrop(t: number): OffscreenCanvas {
    return this.colour ? this.shafts.backdrop(this.bg, this.bgVersion, t, this.dpr) : this.bg;
  }
}
