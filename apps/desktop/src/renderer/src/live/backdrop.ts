/**
 * The water a scene in its own colours swims in: a gradient from the surface down, a faint glow
 * where the light comes in, the cell grid, and light shafts slanting down from the surface that
 * sway and breathe. The gradient, glow and grid are painted once per size and look. The shafts, a
 * few copies of one soft sprite, are laid over a copy of that four times a second, and the copy is
 * what each frame starts from: they move a pixel or two in that time, and drawn every frame over
 * the window they cost 3 ms a frame at 1×, 9 at 2×, in software.
 */
import { type Oklch, type Rgb, cssAlpha, css, rgbOf } from "./colour";
import { paintGrid } from "./cells";

/** A scene's water as its palette sets it (palette.ts), in OKLCH. */
export interface WaterLook {
  /** Top to bottom, evenly spaced. */
  water: Oklch[];
  glow: { colour: Oklch; alpha: number } | null;
  grid: { colour: Oklch; alpha: number };
  shafts: { colour: Oklch; alpha: number; add: boolean } | null;
}

export interface Water {
  /** Top to bottom, evenly spaced. */
  stops: Rgb[];
  /** A soft brightening at the top centre, where the light comes in. */
  glow: { colour: Rgb; alpha: number } | null;
  /** The grid's lines, over the water. */
  grid: { colour: Rgb; alpha: number };
  /** Light shafts: their colour and strength at the surface; null for none. */
  shafts: { colour: Rgb; alpha: number; add: boolean } | null;
}

/** The water to paint, from a palette's. */
export function waterOf(p: WaterLook): Water {
  return {
    stops: p.water.map(rgbOf),
    glow: p.glow && { colour: rgbOf(p.glow.colour), alpha: p.glow.alpha },
    grid: { colour: rgbOf(p.grid.colour), alpha: p.grid.alpha },
    shafts: p.shafts && { colour: rgbOf(p.shafts.colour), alpha: p.shafts.alpha, add: p.shafts.add },
  };
}

export function paintWater(g: OffscreenCanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, dpr: number, water: Water) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grad = g.createLinearGradient(0, 0, 0, H);
  water.stops.forEach((c, i) => grad.addColorStop(i / Math.max(1, water.stops.length - 1), css(c)));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  if (water.glow) {
    const r = Math.max(W, H) * 0.7;
    const glow = g.createRadialGradient(W * 0.5, -H * 0.15, 0, W * 0.5, -H * 0.15, r);
    glow.addColorStop(0, cssAlpha(water.glow.colour, water.glow.alpha));
    glow.addColorStop(1, cssAlpha(water.glow.colour, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
  }
  paintGrid(g, W, H, cw, ch, dpr, cssAlpha(water.grid.colour, water.grid.alpha));
}

/** One shaft's place, from a seed: where it enters, how wide, how far it reaches, its slant. */
interface Shaft {
  x: number;
  width: number;
  reach: number;
  slant: number;
  phase: number;
  period: number;
}

const SPRITE_W = 64;
const SPRITE_H = 256;
/** How often the shafts are laid over the water again, in seconds. */
const EVERY = 0.25;

export class Shafts {
  private sprite = new OffscreenCanvas(SPRITE_W, SPRITE_H);
  /** The water with the shafts over it, as last laid (`backdrop`). */
  private lit = new OffscreenCanvas(1, 1);
  private litAt = -Infinity;
  private litOver: OffscreenCanvas | null = null;
  private litVersion = -1;
  private shafts: Shaft[] = [];
  private alpha = 0;
  private add = false;
  private on = false;

  /** Paint the sprite in this colour: bright down its middle, fading to its sides and its end. */
  setLook(look: Water["shafts"]) {
    this.on = !!look;
    this.litAt = -Infinity;
    if (!look) return;
    this.alpha = look.alpha;
    this.add = look.add;
    const g = this.sprite.getContext("2d");
    if (!g) return;
    const img = g.createImageData(SPRITE_W, SPRITE_H);
    const [r, gr, b] = look.colour;
    for (let y = 0; y < SPRITE_H; y++) {
      const v = y / (SPRITE_H - 1);
      // Brightest just below the surface, gone by the end.
      const along = Math.pow(1 - v, 1.6) * Math.min(1, v * 8 + 0.35);
      for (let x = 0; x < SPRITE_W; x++) {
        const u = (x + 0.5) / SPRITE_W - 0.5;
        const across = Math.exp(-(u * u) / 0.045);
        const i = (y * SPRITE_W + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = gr;
        img.data[i + 2] = b;
        img.data[i + 3] = Math.round(255 * along * across);
      }
    }
    g.putImageData(img, 0, 0);
  }

  /** Lay the shafts out for a window: a few, spread along the top, slanting the same way. */
  resize(W: number, H: number) {
    this.litAt = -Infinity;
    const n = Math.max(3, Math.min(6, Math.round(W / 320)));
    // A fixed spread, not random: the same window shows the same light.
    this.shafts = Array.from({ length: n }, (_, i) => {
      const k = (i + 0.5) / n;
      const wobble = Math.sin(i * 12.9898) * 0.5;
      return {
        x: W * (k + wobble * 0.12 / n * 3),
        width: Math.min(W, H) * (0.1 + 0.12 * Math.abs(Math.sin(i * 4.1 + 1))),
        reach: H * (0.62 + 0.3 * Math.abs(Math.sin(i * 2.3 + 0.7))),
        slant: 0.32 + 0.06 * Math.sin(i * 1.7),
        phase: i * 1.9,
        period: 13 + 6 * Math.abs(Math.sin(i * 3.3)),
      };
    });
  }

  /** What a frame starts from at time `t`: `water` (painted at `version`) with the shafts over it,
   *  laid again when a quarter second has passed or the water was painted again; `water` itself
   *  when there are none. */
  backdrop(water: OffscreenCanvas, version: number, t: number, dpr: number): OffscreenCanvas {
    if (!this.on) return water;
    if (this.litOver === water && this.litVersion === version && Math.abs(t - this.litAt) < EVERY) return this.lit;
    this.litOver = water;
    this.litVersion = version;
    this.litAt = t;
    const lit = this.lit;
    if (lit.width !== water.width || lit.height !== water.height) {
      lit.width = water.width;
      lit.height = water.height;
    }
    const g = lit.getContext("2d");
    if (!g) return water;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "copy";
    g.drawImage(water, 0, 0);
    g.globalCompositeOperation = this.add ? "lighter" : "source-over";
    g.imageSmoothingEnabled = true;
    for (const s of this.shafts) {
      g.globalAlpha = this.alpha * (0.6 + 0.4 * Math.sin((t / s.period) * Math.PI * 2 + s.phase));
      const sway = Math.sin((t / (s.period * 2.3)) * Math.PI * 2 + s.phase) * s.width * 0.35;
      // Down from the surface, slanting: a shear, so the shaft's top stays along the surface.
      g.setTransform(dpr, 0, dpr * s.slant, dpr, dpr * (s.x + sway - s.width / 2), 0);
      g.drawImage(this.sprite, 0, 0, s.width, s.reach);
    }
    return lit;
  }
}
