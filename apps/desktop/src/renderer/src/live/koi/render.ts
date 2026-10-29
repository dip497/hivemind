/**
 * Koi Pond's drawing: the water and what swims in it (swim.ts), its koi by their varieties
 * (shapes.ts), pebbles on the bottom and each koi's shadow on it, and over them the surface
 * (pond.ts): rings where something touches it, and lily pads, which the koi swim under.
 *
 * A pad is drawn once into a sprite of its own cells and copied in each frame; it is drawn again
 * when it has turned a step, the look changed, or a tile over it moved. A pad drifts a whole cell
 * at a time, as everything in the scene does.
 */
import { css, cssAlpha, mix, ramp as rampOf, rgbOf, type Oklch } from "../colour";
import { clamp, hash3, TAU } from "../math";
import type { Box } from "../scene";
import { FLAG_EDGE } from "../spine";
import { SwimRenderer, type SwimPalette } from "../swim";
import type { World } from "../world";
import { KOI_PALETTE, type KoiPalette } from "./palette";
import { padCell, PadPart, Pond, RIPPLE_LIFE, RIPPLE_SPEED, type Pad } from "./pond";
import { KOI_KINDS, KOI_MONO_MARKS, KOI_MONO_SKIN, KOI_SHAPES, KOI_TINTS } from "./shapes";

const LEAF_GLYPHS = "o08%t";
const RIM_GLYPHS = ":.";
const PEBBLE_GLYPHS = "o.,";
/** How far a pad turns before its sprite is drawn again. */
const TURN_STEP = 0.06;
const RIPPLE_LEVELS = 6;

type Style = { block: string; glyph: string };

/** A line out from a pad's middle, drawn along its direction. */
function veinGlyph(dx: number, dy: number) {
  const a = ((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI;
  return a < Math.PI / 8 || a > (7 * Math.PI) / 8 ? "-" : a < (3 * Math.PI) / 8 ? "\\" : a < (5 * Math.PI) / 8 ? "|" : "/";
}

export class KoiRenderer extends SwimRenderer {
  private pond = new Pond();
  private sprites: ({ canvas: OffscreenCanvas; key: string } | undefined)[] = [];
  private padStyles: Style[] = [];
  private rippleStyles: string[] = [];
  private pebbleStyle = "";
  private shadeStyle: string | null = null;
  /** Counted, so a pad's sprite knows it was drawn for another look or other tiles. */
  private lookVersion = 0;
  private coverVersion = 0;
  /** Cells a ring has lit this frame: two rings meeting light a cell once. */
  private rung = new Uint32Array(0);
  private ringFrame = 0;

  constructor(canvas: OffscreenCanvas) {
    super(canvas, { shapes: KOI_SHAPES, kinds: KOI_KINDS, tints: KOI_TINTS, monoMarks: KOI_MONO_MARKS, monoSkin: KOI_MONO_SKIN, palette: KOI_PALETTE });
    this.looked(null);
  }

  protected looked(palette: SwimPalette | null) {
    this.lookVersion++;
    if (!palette) {
      // The theme's colours: a pad mid-tone, its veins and flower brighter, no shadows.
      const tone = (block: number, glyph: number): Style => ({ block: this.tone(block), glyph: this.tone(glyph) });
      // Darker than a koi, so the koi read over them.
      this.padStyles = [tone(0, 0), tone(0.09, 0.22), tone(0.13, 0.26), tone(0.09, 0.3), tone(0.36, 0.8), tone(0.55, 0.95)];
      this.rippleStyles = Array.from({ length: RIPPLE_LEVELS }, (_, l) => this.tone(0.12 + (0.5 * (l + 1)) / RIPPLE_LEVELS));
      this.pebbleStyle = this.tone(this.light ? 0.06 : 0.07);
      this.shadeStyle = null;
      return;
    }
    const p = (palette as KoiPalette).pond;
    const c = (o: Oklch) => css(rgbOf(o));
    const style = (block: Oklch, glyph: Oklch): Style => ({ block: c(block), glyph: c(glyph) });
    this.padStyles = [
      style(p.pad, p.pad),
      style(p.pad, p.padGlyph),
      { block: c(p.rim), glyph: css(mix(rgbOf(p.rim), rgbOf(p.padGlyph), 0.55)) },
      style(p.pad, p.vein),
      style(p.petal, p.petalGlyph),
      { block: c(p.heart), glyph: css(mix(rgbOf(p.heart), rgbOf(p.petal), 0.6)) },
    ];
    const ring = rampOf(rgbOf(palette.water[1]!), rgbOf(p.ripple)).styles;
    this.rippleStyles = Array.from({ length: RIPPLE_LEVELS }, (_, l) => this.tone((0.25 + (0.75 * (l + 1)) / RIPPLE_LEVELS), ring));
    this.pebbleStyle = c(p.pebble);
    this.shadeStyle = cssAlpha(rgbOf(p.shade), p.shadeAlpha);
  }

  protected allocate(n: number) {
    super.allocate(n);
    this.rung = new Uint32Array(n);
  }

  resize(width: number, height: number, dpr: number) {
    const was = [this.width, this.height];
    super.resize(width, height, dpr);
    if (was[0] !== width || was[1] !== height) this.pond.build(width, height);
    this.sprites = [];
  }

  setBoxes(boxes: readonly Box[], seeThrough: boolean) {
    const moved = super.setBoxes(boxes, seeThrough);
    if (moved) this.coverVersion++;
    return moved;
  }

  /** The water, and pebbles on the bottom, here and there, faint. */
  protected paintBackground() {
    super.paintBackground();
    const g = this.bg.getContext("2d");
    if (!g || !this.pebbleStyle) return;
    const { dpr, cols, rows, cw, ch } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = this.pebbleStyle;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = hash3(c, r, 0x9eb);
        if (h < 0.022) g.fillText(PEBBLE_GLYPHS[Math.floor((h / 0.022) * PEBBLE_GLYPHS.length)]!, c * cw + cw / 2, r * ch + ch / 2 + 1);
      }
    }
  }

  protected consumeEvents(world: World) {
    for (const e of world.events) this.pond.ripple(e.x, e.y, e.kind === "eat" ? 0.4 : 1);
    super.consumeEvents(world);
  }

  render(world: World, dt: number) {
    this.pond.step(dt);
    this.pond.surface(world.swimmers, world.time);
    super.render(world, dt);
  }

  /** Each koi's shadow on the bottom: down and right of it, by a cell. */
  protected drawUnder() {
    if (!this.shadeStyle) return;
    const { ctx, dpr, cols, rows, cw, ch, cover } = this;
    const flag = this.raster.flag;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.shadeStyle;
    const last = cols * (rows - 1) - 1;
    for (let i = 0; i < last; i++) {
      const f = flag[i];
      if (!f || f === FLAG_EDGE || i % cols === cols - 1) continue;
      const j = i + cols + 1;
      if (flag[j] || cover[j]) continue;
      ctx.fillRect((j % cols) * cw, ((j / cols) | 0) * ch, cw, ch);
    }
  }

  protected drawOver() {
    this.drawRipples();
    this.drawPads();
  }

  private drawRipples() {
    const { ctx, cw, cover, rung } = this;
    const frame = ++this.ringFrame;
    for (const r of this.pond.ripples) {
      const fade = Math.pow(1 - r.age / RIPPLE_LIFE, 1.4) * (0.45 + 0.55 * r.strength);
      if (fade < 0.06) continue;
      ctx.fillStyle = this.rippleStyles[clamp(Math.floor(fade * RIPPLE_LEVELS), 0, RIPPLE_LEVELS - 1)]!;
      const glyph = fade > 0.5 ? "o" : ".";
      const radius = 4 + RIPPLE_SPEED * r.age * (0.6 + 0.4 * r.strength);
      // A strong ring has another inside it.
      for (const R of r.strength > 0.6 ? [radius, radius * 0.62] : [radius]) {
        const steps = Math.max(8, Math.ceil((TAU * R) / (cw * 0.8)));
        for (let s = 0; s < steps; s++) {
          const a = (s / steps) * TAU;
          const i = this.cellIndex(r.x + Math.cos(a) * R, r.y + Math.sin(a) * R);
          if (i < 0 || cover[i] || rung[i] === frame) continue;
          rung[i] = frame;
          ctx.fillText(glyph, (i % this.cols) * cw + cw / 2, ((i / this.cols) | 0) * this.ch + this.ch / 2 + 1);
        }
      }
    }
  }

  private drawPads() {
    const { ctx, cw, ch } = this;
    this.pond.pads.forEach((p, k) => {
      const cx = Math.floor(p.x / cw);
      const cy = Math.floor(p.y / ch);
      const rc = Math.ceil(p.r / cw) + 1;
      const rr = Math.ceil(p.r / ch) + 1;
      const c0 = cx - rc;
      const r0 = cy - rr;
      const w = 2 * rc + 1;
      const h = 2 * rr + 1;
      const x0 = c0 * cw;
      const y0 = r0 * ch;
      // Only a pad a tile or panel is over is drawn again as it drifts: its cells under it are left out.
      const under = this.boxes.some((b) => b.x1 > x0 && b.x0 < x0 + w * cw && b.y1 > y0 && b.y0 < y0 + h * ch);
      const turn = Math.round(p.turn / TURN_STEP);
      const key = `${turn}|${this.lookVersion}|${under ? `${this.coverVersion}|${cx},${cy}` : ""}`;
      let sprite = this.sprites[k];
      if (!sprite || sprite.key !== key) sprite = this.sprites[k] = this.paintPad(p, turn * TURN_STEP, c0, r0, w, h, under, key, sprite?.canvas);
      ctx.drawImage(sprite.canvas, x0, y0, w * cw, h * ch);
    });
  }

  private paintPad(p: Pad, turn: number, c0: number, r0: number, w: number, h: number, under: boolean, key: string, reuse?: OffscreenCanvas) {
    const { dpr, cw, ch, cols, rows, cover } = this;
    const canvas = reuse ?? new OffscreenCanvas(1, 1);
    const W = Math.ceil(w * cw * dpr);
    const H = Math.ceil(h * ch * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const g = canvas.getContext("2d");
    if (!g) return { canvas, key };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const shape = { ...p, turn };
    const rc = (w - 1) / 2;
    const rr = (h - 1) / 2;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const dx = (i - rc) * cw;
        const dy = (j - rr) * ch;
        const part = padCell(shape, dx, dy, cw);
        if (part === PadPart.None) continue;
        if (under) {
          const c = c0 + i;
          const r = r0 + j;
          if (c >= 0 && r >= 0 && c < cols && r < rows && cover[r * cols + c]) continue;
        }
        const style = this.padStyles[part]!;
        g.fillStyle = style.block;
        g.fillRect(i * cw + 1, j * ch + 1, cw - 1, ch - 1);
        const glyph =
          part === PadPart.Vein ? veinGlyph(dx, dy)
          : part === PadPart.Rim ? RIM_GLYPHS[Math.floor(hash3(i - rc, j - rr, p.seed) * RIM_GLYPHS.length)]!
          : part === PadPart.Petal ? "*"
          : part === PadPart.Heart ? "o"
          : hash3(i - rc, j - rr, p.seed + 1) < 0.55 ? LEAF_GLYPHS[Math.floor(hash3(i - rc, j - rr, p.seed) * LEAF_GLYPHS.length)]! : "";
        if (!glyph) continue;
        g.fillStyle = style.glyph;
        g.fillText(glyph, i * cw + cw / 2, j * ch + ch / 2 + 1);
      }
    }
    return { canvas, key };
  }
}
