/**
 * Jellyfish's drawing, in cells: the water (look.ts), marine snow, a soft glow behind each jelly,
 * its tentacles and oral arms drawn along the way they hang, and over them its bell: translucent, a
 * faint block in each cell with its outline and its pattern drawn in characters, brighter at its
 * edge. A jelly whose agent needs you glows, slowly brighter and fainter; one whose turn ended well
 * flashes. Under a see-through tile a jelly is drawn soft, as Shoal's sharks are.
 */
import { css, mix, ramp as rampOf, rgbOf, RAMP, type Ramp } from "../colour";
import { glowSprite } from "../glow";
import { LookRenderer, themeRamp } from "../look";
import { clamp, hash3 } from "../math";
import { JELLY_KINDS, type JellyKind } from "./kinds";
import { JELLY_PALETTE, type JellyPalette } from "./palette";
import { bellOf, type Jelly, type Swarm } from "./swarm";

/** How far toward its colour a jelly under a see-through tile is drawn, against one in the open. */
const SOFT = 0.55;
const ARM_GLYPHS = "%&S$";

interface KindStyles {
  bell: Ramp;
  mark: Ramp;
  mark2: Ramp;
  tentacle: Ramp;
  glow: OffscreenCanvas;
}

/** A line along (dx, dy), as a character. */
function lineGlyph(dx: number, dy: number) {
  if (Math.abs(dx) < Math.abs(dy) * 0.45) return "|";
  if (Math.abs(dy) < Math.abs(dx) * 0.45) return "-";
  return dx * dy > 0 ? "\\" : "/";
}

export class JellyRenderer extends LookRenderer<JellyPalette> {
  private styles = {} as Record<JellyKind, KindStyles>;
  private snowStyles = ["", ""];
  /** How lit each part of a pattern is against the bell (in the theme's colours, where they share
   *  one ramp), and whether glows add light (on dark water) or tint (on light). */
  private slotScale = [1, 1, 1];
  private glowAdd = true;
  private shine = 0;
  /** Cells this jelly has drawn this frame: its strands cross, and a cell is drawn once. */
  private drawn = new Uint32Array(0);
  private pass = 0;

  constructor(canvas: OffscreenCanvas) {
    super(canvas, JELLY_PALETTE);
    this.setLook({ page: 0x000000, text: 0xffffff, colour: false });
  }

  protected allocate(n: number) {
    this.drawn = new Uint32Array(n);
  }

  protected styled() {
    const p = this.colour;
    this.glowAdd = !this.light;
    if (p) {
      const mid = rgbOf(p.water[1]!);
      for (const k of JELLY_KINDS) {
        const c = p.kinds[k];
        this.styles[k] = {
          bell: rampOf(mid, rgbOf(c.bell)),
          mark: rampOf(mid, rgbOf(c.mark)),
          mark2: rampOf(mid, rgbOf(c.mark2)),
          tentacle: rampOf(mid, rgbOf(c.tentacle)),
          glow: glowSprite(rgbOf(c.mark2)),
        };
      }
      this.snowStyles = [css(mix(mid, rgbOf(p.snow), 0.4)), css(mix(mid, rgbOf(p.snow), 0.75))];
      this.slotScale = [1, 1, 1];
      this.shine = p.shine;
      return;
    }
    // The theme's colours: one ramp for every kind, its pattern told apart by how lit it is.
    const ramp = themeRamp(this.page, this.text);
    const glow = glowSprite([(this.text >> 16) & 255, (this.text >> 8) & 255, this.text & 255]);
    for (const k of JELLY_KINDS) this.styles[k] = { bell: ramp, mark: ramp, mark2: ramp, tentacle: ramp, glow };
    this.snowStyles = [this.tone(0.14), this.tone(0.28)];
    this.slotScale = [1, 0.6, 1.2];
    this.shine = 0;
  }

  render(swarm: Swarm, _dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = swarm.time;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.backdrop(t), 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawSnow(swarm);
    for (const j of swarm.jellies) this.drawGlow(j, t);
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Its bell first, in front of its own tentacles, which hang behind it.
    for (const j of swarm.jellies) {
      this.pass++;
      this.drawBell(j, t);
      this.drawStrands(j);
    }
    if (this.softAny) this.drawSoft();
  }

  /** Marine snow: a speck in its cell, low in it, nearer specks brighter. */
  private drawSnow(swarm: Swarm) {
    const { ctx, cw, ch, cover } = this;
    for (let near = 0; near < 2; near++) {
      ctx.fillStyle = this.snowStyles[near]!;
      const size = near ? 2 : 1.5;
      for (const m of swarm.snow) {
        if ((m.z > 0.7 ? 1 : 0) !== near) continue;
        const i = this.cellIndex(m.x, m.y);
        if (i < 0 || cover[i]) continue;
        ctx.fillRect(Math.floor(m.x / cw) * cw + cw * 0.5, Math.floor(m.y / ch) * ch + ch * 0.6, size, size);
      }
    }
  }

  /** The light round a jelly: faint always in its own colours, slowly breathing while its agent
   *  needs you, a flash when a turn ended well. */
  private drawGlow(j: Jelly, t: number) {
    const call = j.mood === "surface" && !j.leaving ? 0.2 + 0.14 * Math.sin(t * 2.6 + j.id) : 0;
    const a = clamp(this.shine * (0.5 + 0.5 * j.depth) + call + j.glow * 0.55, 0, 1);
    if (a < 0.02) return;
    const { ctx } = this;
    const { w, h } = bellOf(j);
    const r = w * (1.9 + j.glow * 0.8);
    const cx = j.x + Math.sin(j.tilt) * h * 0.5;
    const cy = j.y - Math.cos(j.tilt) * h * 0.5;
    ctx.save();
    ctx.globalCompositeOperation = this.glowAdd ? "lighter" : "source-over";
    ctx.globalAlpha = this.glowAdd ? a : a * 0.6;
    ctx.drawImage(this.styles[j.kind].glow, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  /** One cell of a jelly: its block faint, its character stronger, `level` toward its colour. Under
   *  a see-through tile, soft. */
  private cell(i: number, ramp: Ramp, level: number, glyph: string, block = true) {
    const { ctx, cols, cw, ch } = this;
    if (this.cover[i]) {
      this.softPixel(i, ramp.pixels[clamp(Math.round(level * SOFT * RAMP), 0, RAMP)]!);
      return;
    }
    const x = (i % cols) * cw;
    const y = ((i / cols) | 0) * ch;
    if (block) {
      ctx.fillStyle = ramp.styles[clamp(Math.round(level * 0.5 * RAMP), 0, RAMP)]!;
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
    }
    if (!glyph) return;
    ctx.fillStyle = ramp.styles[clamp(Math.round(Math.min(1, level * 0.5 + 0.42) * RAMP), 0, RAMP)]!;
    ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
  }

  /** Whether cell `i` is this jelly's to draw: in the grid, not under a solid tile, and not drawn
   *  by it already this frame. */
  private claim(i: number) {
    if (i < 0 || this.drawn[i] === this.pass || (this.cover[i] && !this.seeThrough)) return false;
    this.drawn[i] = this.pass;
    return true;
  }

  private drawStrands(j: Jelly) {
    const s = this.styles[j.kind];
    const near = 0.55 + 0.45 * j.depth;
    for (const strand of j.strands) {
      const n = strand.nodes;
      const count = n.length / 2;
      for (let k = 1; k < count; k++) {
        const i = this.cellIndex(n[k * 2]!, n[k * 2 + 1]!);
        if (!this.claim(i)) continue;
        const along = k / (count - 1);
        if (strand.arm) {
          // An arm: frilled, a block under each of its characters, its tip in the second colour.
          const ramp = along > 0.8 ? s.mark2 : s.mark;
          this.cell(i, ramp, (0.9 - 0.3 * along) * near + j.glow * 0.3, ARM_GLYPHS[(k + Math.round(strand.anchor * 5)) & 3]!);
        } else {
          const glyph = k === count - 1 ? "." : lineGlyph(n[k * 2]! - n[(k - 1) * 2]!, n[k * 2 + 1]! - n[(k - 1) * 2 + 1]!);
          this.cell(i, s.tentacle, (0.85 - 0.4 * along) * near + j.glow * 0.3, glyph, along < 0.55);
        }
      }
    }
  }

  private drawBell(j: Jelly, t: number) {
    const { cw, ch, cols, rows } = this;
    const s = this.styles[j.kind];
    const shape = j.shape;
    const { w, h } = bellOf(j);
    const skirt = shape.skirt * h;
    const cos = Math.cos(j.tilt);
    const sin = Math.sin(j.tilt);
    /** How far out of the bell's outline a point (dx, dy) from its rim's middle is: 0 at its
     *  middle, 1 on its outline, more outside; and how far down it, 0 the top to 1 the rim. */
    const at = (dx: number, dy: number) => {
      const lx = dx * cos + dy * sin;
      const hy = dx * sin - dy * cos;
      const u = lx / w;
      if (hy >= 0) return { f: Math.pow(Math.abs(u), shape.dome) + (hy / h) ** 2, u, v: 1 - hy / h, skirt: false };
      // The rim below the dome, narrowing a little, its hem scalloped.
      const down = -hy / (skirt || 1);
      if (down > 1 || skirt === 0) return { f: 2, u, v: 1, skirt: true };
      const hem = down > 0.55 && Math.sin((u + 1) * Math.PI * 4) < -0.2;
      return { f: hem ? 2 : Math.abs(u) / (1 - 0.12 * down), u, v: 1, skirt: true };
    };
    const reach = Math.max(w, h + skirt) + Math.max(cw, ch);
    const c0 = Math.max(0, Math.floor((j.x - reach) / cw));
    const c1 = Math.min(cols - 1, Math.floor((j.x + reach) / cw));
    const r0 = Math.max(0, Math.floor((j.y - reach) / ch));
    const r1 = Math.min(rows - 1, Math.floor((j.y + reach) / ch));
    const near = 0.55 + 0.45 * j.depth;
    const ramps = [s.bell, s.mark, s.mark2];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = c * cw + cw / 2 - j.x;
        const dy = r * ch + ch / 2 - j.y;
        const mid = at(dx, dy);
        let inside = mid.f <= 1 ? 1 : 0;
        for (const [ox, oy] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]] as const) if (at(dx + ox * cw, dy + oy * ch).f <= 1) inside++;
        if (inside < 2) continue;
        const i = r * cols + c;
        if (!this.claim(i)) continue;
        const edge = inside < 5 || mid.f > 0.78;
        const slot = mid.f <= 1 ? shape.pattern(mid.u, clamp(mid.v, 0, 1), t) : 0;
        // Clear in its middle, bright at its edge and toward its top: light through a bell.
        const lit = edge ? 0.95 : 0.5 + 0.2 * (1 - mid.v) + 0.22 * mid.f;
        const level = Math.min(1, lit * near * this.slotScale[slot]! + j.glow * 0.35);
        const key = hash3(c - Math.round(j.x / cw), r - Math.round(j.y / ch), j.id);
        let glyph: string;
        if (edge) {
          glyph = mid.skirt ? (c % 2 ? "~" : "v") : mid.v < 0.3 ? (Math.abs(mid.u) < 0.45 ? "-" : mid.u < 0 ? "/" : "\\") : mid.u < 0 ? "(" : ")";
        } else if (slot === 1) glyph = "@o%"[Math.floor(key * 3)]!;
        else if (slot === 2) glyph = "*";
        else glyph = key < 0.3 ? ":" : key < 0.5 ? "." : "";
        // An outline cell the bell only partly covers is its character alone: a soft edge.
        this.cell(i, ramps[slot]!, level, glyph, inside === 5);
      }
    }
  }
}
