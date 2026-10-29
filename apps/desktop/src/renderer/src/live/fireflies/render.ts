/**
 * Fireflies' drawing, in cells: the sky (look.ts) and its stars, twinkling; the grass along the
 * bottom, drawn once into a layer, and the tall reeds over it, swaying; and the fireflies, each a
 * soft glow with its light in its cells: a small one a single cell, an agent's a lantern of two
 * by two, its head before it and its wings beating over it (folded when it rests). Under a see-through tile an
 * agent's firefly is drawn soft, as Shoal's sharks are.
 */
import { css, mix, ramp as rampOf, rgbOf, RAMP, type Ramp, type Rgb } from "../colour";
import { glowSprite } from "../glow";
import { LookRenderer, themeRamp } from "../look";
import { clamp } from "../math";
import type { Box } from "../scene";
import { FIREFLY_KINDS, type FireflyKind } from "./kinds";
import type { Meadow } from "./meadow";
import { FIREFLY_PALETTE, type FireflyPalette } from "./palette";

const SOFT = 0.55;
const STAR_LEVELS = 3;
const BLADE_TOPS = "',v/\\Y";
const BLADE_STEMS = "|li!";

/** A small seeded generator (mulberry32), apart from Math.random, which the meadow's run keeps. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Reed {
  c: number;
  foot: number;
  height: number;
  phase: number;
}

export class FireflyRenderer extends LookRenderer<FireflyPalette> {
  private lights = {} as Record<FireflyKind, { ramp: Ramp; glow: OffscreenCanvas }>;
  private mote: { ramp: Ramp; glow: OffscreenCanvas } | null = null;
  private bodyStyle = "";
  private wingStyle = "";
  private grassStyles = { near: "", far: "", reed: "" };
  private starStyles: string[] = [];
  private add = true;
  /** The grass's cells, drawn once into a layer the height of the grass, again only when the
   *  grid, the look or the cells the tiles cover change. */
  private grass: { c: number; r: number; glyph: string; far: boolean }[] = [];
  private reeds: Reed[] = [];
  private stars: { x: number; y: number; rate: number; phase: number }[] = [];
  private layer = new OffscreenCanvas(1, 1);
  private layerTop = 0;
  private layerFresh = false;

  constructor(canvas: OffscreenCanvas) {
    super(canvas, FIREFLY_PALETTE);
    this.setLook({ page: 0x000000, text: 0xffffff, colour: false });
  }

  protected styled() {
    this.layerFresh = false;
    const p = this.colour;
    if (p) {
      const body = rgbOf(p.body);
      for (const k of FIREFLY_KINDS) this.lights[k] = { ramp: rampOf(body, rgbOf(p.kinds[k])), glow: glowSprite(rgbOf(p.kinds[k])) };
      this.mote = { ramp: rampOf(rgbOf(p.water[1]!), rgbOf(p.mote)), glow: glowSprite(rgbOf(p.mote)) };
      this.bodyStyle = css(body);
      this.wingStyle = css(mix(body, rgbOf(p.water[0]!), 0.15));
      this.grassStyles = { near: css(rgbOf(p.grass)), far: css(rgbOf(p.far)), reed: css(rgbOf(p.reed)) };
      const star = rgbOf(p.star);
      const sky = rgbOf(p.water[0]!);
      this.starStyles = p.stars ? Array.from({ length: STAR_LEVELS }, (_, l) => css(mix(sky, star, (p.stars * (l + 1)) / STAR_LEVELS))) : [];
      this.add = p.add;
      return;
    }
    // The theme's colours: every light the text colour, the grass and stars steps toward it.
    const ramp = themeRamp(this.page, this.text);
    const text: Rgb = [(this.text >> 16) & 255, (this.text >> 8) & 255, this.text & 255];
    const glow = glowSprite(text);
    for (const k of FIREFLY_KINDS) this.lights[k] = { ramp, glow };
    this.mote = { ramp, glow };
    this.bodyStyle = this.tone(0.3);
    this.wingStyle = this.tone(0.22);
    this.grassStyles = { near: this.tone(0.24), far: this.tone(0.12), reed: this.tone(0.3) };
    this.starStyles = Array.from({ length: STAR_LEVELS }, (_, l) => this.tone((this.light ? 0.12 : 0.22) * ((l + 1) / STAR_LEVELS)));
    this.add = !this.light;
  }

  protected allocate() {
    this.layout();
    this.layerFresh = false;
  }

  setBoxes(boxes: readonly Box[], seeThrough: boolean) {
    const moved = super.setBoxes(boxes, seeThrough);
    if (moved) this.layerFresh = false;
    return moved;
  }

  /** The grass along the bottom, a far row and a near one, its reeds, and the stars, from a fixed
   *  seed: the same window shows the same meadow. */
  private layout() {
    const { cols, rows, cw, ch } = this;
    const rnd = prng(0xf1e1d + cols * 31 + rows);
    const bottom = rows - 1;
    this.grass = [];
    const a = rnd() * 9;
    for (let c = 0; c < cols; c++) {
      const far = Math.max(2, Math.round(4 + 2 * Math.sin(c * 0.06 + a) + rnd() * 2));
      for (let k = 0; k < far; k++) this.grass.push({ c, r: bottom - k, glyph: k === far - 1 ? BLADE_TOPS[Math.floor(rnd() * BLADE_TOPS.length)]! : BLADE_STEMS[Math.floor(rnd() * BLADE_STEMS.length)]!, far: true });
      if (rnd() < 0.55) {
        const near = 1 + Math.floor(rnd() * 3.5);
        for (let k = 0; k < near; k++) this.grass.push({ c, r: bottom - k, glyph: k === near - 1 ? BLADE_TOPS[Math.floor(rnd() * BLADE_TOPS.length)]! : BLADE_STEMS[Math.floor(rnd() * BLADE_STEMS.length)]!, far: false });
      }
    }
    this.reeds = Array.from({ length: Math.max(4, Math.round(cols / 10)) }, () => ({
      c: Math.floor(rnd() * cols), foot: bottom, height: 7 + Math.floor(rnd() * Math.min(8, rows * 0.12)), phase: rnd() * Math.PI * 2,
    }));
    this.stars = Array.from({ length: Math.round((cols * cw * rows * ch) / 9000) }, () => ({
      x: rnd() * cols * cw, y: rnd() * rows * ch * 0.62, rate: 0.6 + rnd() * 1.8, phase: rnd() * Math.PI * 2,
    }));
  }

  render(meadow: Meadow, _dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = meadow.time;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.backdrop(t), 0, 0);
    this.drawStars(t);
    this.drawGrass();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.drawReeds(t);
    this.drawGlows(meadow);
    this.drawMotes(meadow);
    for (const f of meadow.flies) this.drawFly(meadow, f, t);
    if (this.softAny) this.drawSoft();
  }

  private drawStars(t: number) {
    if (!this.starStyles.length) return;
    const { ctx, dpr, cover } = this;
    for (let l = 0; l < STAR_LEVELS; l++) {
      ctx.fillStyle = this.starStyles[l]!;
      for (const s of this.stars) {
        const b = 0.5 + 0.5 * Math.sin(t * s.rate + s.phase);
        if (Math.min(STAR_LEVELS - 1, Math.floor(b * STAR_LEVELS)) !== l) continue;
        const i = this.cellIndex(s.x, s.y);
        if (i < 0 || cover[i]) continue;
        ctx.fillRect(Math.round(s.x * dpr), Math.round(s.y * dpr), Math.max(1, Math.round(dpr * 1.5)), Math.max(1, Math.round(dpr * 1.5)));
      }
    }
  }

  /** The grass, from its layer, drawn again first if anything changed. The transform is 1:1. */
  private drawGrass() {
    const { ctx, dpr, cols, rows, cw, ch, cover } = this;
    if (!this.layerFresh) {
      this.layerFresh = true;
      let top = rows;
      for (const g of this.grass) top = Math.min(top, g.r);
      this.layerTop = top;
      const w = Math.max(1, Math.round(cols * cw * dpr));
      const h = Math.max(1, Math.round((rows - top) * ch * dpr));
      if (this.layer.width !== w || this.layer.height !== h) {
        this.layer.width = w;
        this.layer.height = h;
      }
      const g = this.layer.getContext("2d");
      if (g) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, w, h);
        g.setTransform(dpr, 0, 0, dpr, 0, -top * ch * dpr);
        g.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        for (const far of [true, false]) {
          g.fillStyle = far ? this.grassStyles.far : this.grassStyles.near;
          for (const b of this.grass) {
            if (b.far !== far || cover[b.r * cols + b.c]) continue;
            g.fillText(b.glyph, b.c * cw + cw / 2 + (far ? 0 : cw * 0.3), b.r * ch + ch / 2 + 1);
          }
        }
      }
    }
    ctx.drawImage(this.layer, 0, Math.round(this.layerTop * ch * dpr));
  }

  private drawReeds(t: number) {
    const { ctx, cols, rows, cw, ch, cover } = this;
    ctx.fillStyle = this.grassStyles.reed;
    for (const reed of this.reeds) {
      let below = 0;
      for (let k = 0; k < reed.height; k++) {
        const lean = Math.pow(k / reed.height, 1.4);
        const off = Math.round(1.4 * lean * Math.sin(t * 0.6 + reed.phase));
        const c = reed.c + off;
        const r = reed.foot - k;
        const dx = off - below;
        below = off;
        if (c < 0 || c >= cols || r < 0 || r >= rows || cover[r * cols + c]) continue;
        const glyph = k === reed.height - 1 ? "Y" : dx < 0 ? "\\" : dx > 0 ? "/" : "|";
        ctx.fillText(glyph, c * cw + cw / 2, r * ch + ch / 2 + 1);
      }
    }
  }

  /** Every firefly's glow, behind all the lights: an agent's wider, brighter as it flashes. */
  private drawGlows(meadow: Meadow) {
    const { ctx, cw } = this;
    ctx.save();
    ctx.globalCompositeOperation = this.add ? "lighter" : "source-over";
    const scale = this.add ? 1 : 0.55;
    if (this.mote) {
      for (const m of meadow.motes) {
        const l = meadow.moteLight(m);
        if (l < 0.05) continue;
        const r = cw * (1.1 + 1.6 * l);
        ctx.globalAlpha = l * 0.7 * scale;
        ctx.drawImage(this.mote.glow, m.x - r, m.y - r, r * 2, r * 2);
      }
    }
    for (const f of meadow.flies) {
      const l = meadow.light(f);
      const r = cw * (2.6 + 4 * l) * (0.8 + 0.25 * f.size);
      ctx.globalAlpha = (0.18 + 0.72 * l) * scale;
      ctx.drawImage(this.lights[f.kind].glow, f.x - r, f.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  private drawMotes(meadow: Meadow) {
    const { ctx, cw, ch, cols, cover } = this;
    const ramp = this.mote!.ramp;
    for (const m of meadow.motes) {
      const l = meadow.moteLight(m);
      if (l < 0.15) continue;
      const i = this.cellIndex(m.x, m.y);
      if (i < 0 || cover[i]) continue;
      const x = (i % cols) * cw;
      const y = ((i / cols) | 0) * ch;
      if (l > 0.55) {
        ctx.fillStyle = ramp.styles[clamp(Math.round(l * 0.7 * RAMP), 0, RAMP)]!;
        ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      }
      ctx.fillStyle = ramp.styles[clamp(Math.round(l * RAMP), 0, RAMP)]!;
      ctx.fillText(l > 0.55 ? "*" : ".", x + cw / 2, y + ch / 2 + 1);
    }
  }

  /** One cell of an agent's firefly: under a see-through tile, soft. */
  private flyCell(c: number, r: number, block: string | null, glyph: string, glyphStyle: string, soft: number | null) {
    const { ctx, cols, rows, cw, ch, cover } = this;
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const i = r * cols + c;
    if (cover[i]) {
      if (this.seeThrough && soft !== null) this.softPixel(i, soft);
      return;
    }
    if (block) {
      ctx.fillStyle = block;
      ctx.fillRect(c * cw + 1, r * ch + 1, cw - 1, ch - 1);
    }
    ctx.fillStyle = glyphStyle;
    ctx.fillText(glyph, c * cw + cw / 2, r * ch + ch / 2 + 1);
  }

  /** An agent's firefly: its lantern two cells by two behind its head, its wings over it, beating
   *  as it flies and folded when it rests. */
  private drawFly(meadow: Meadow, f: Meadow["flies"][number], t: number) {
    const { cw, ch } = this;
    const l = meadow.light(f);
    const ramp = this.lights[f.kind].ramp;
    const at = (k: number) => ramp.styles[clamp(Math.round(k * RAMP), 0, RAMP)]!;
    const px = (k: number) => ramp.pixels[clamp(Math.round(k * SOFT * RAMP), 0, RAMP)]!;
    const c = Math.floor(f.x / cw);
    const r = Math.floor(f.y / ch);
    const back = c - f.facing;
    const lit = 0.25 + 0.75 * l;
    this.flyCell(c, r, at(lit * 0.75), l > 0.5 ? "@" : "o", at(Math.min(1, lit + 0.2)), px(lit));
    this.flyCell(back, r, at(lit * 0.65), l > 0.5 ? "#" : ":", at(Math.min(1, lit + 0.1)), px(lit * 0.85));
    this.flyCell(c, r + 1, at(lit * 0.65), l > 0.5 ? "%" : ":", at(Math.min(1, lit + 0.1)), px(lit * 0.85));
    this.flyCell(back, r + 1, at(lit * 0.55), l > 0.5 ? "8" : ".", at(lit), px(lit * 0.7));
    this.flyCell(c + f.facing, r, null, "o", this.bodyStyle, null);
    const beat = Math.floor(t * 16 + f.id) % 2;
    const wings = f.perched ? ["-", "-"] : beat ? ["\\", "/"] : ["/", "\\"];
    const [a, b] = f.facing > 0 ? wings : [wings[1]!, wings[0]!];
    this.flyCell(Math.min(c, back), r - 1, null, a!, this.wingStyle, null);
    this.flyCell(Math.max(c, back), r - 1, null, b!, this.wingStyle, null);
  }
}
