/**
 * Shoal's drawing: the water and what swims in it (swim.ts), its sharks by their shapes
 * (shapes.ts), and with Colour on, a reef's sea bed along the bottom (seabed.ts).
 */
import type { Box } from "../scene";
import { css, mix, rgbOf, type Oklch } from "../colour";
import { SwimRenderer, type SwimPalette } from "../swim";
import { SHOAL_PALETTE, type ShoalPalette } from "./palette";
import { Seabed, type BedColour } from "./seabed";
import { KIND_LIST, SHAPES, TINTS } from "./shapes";

export class ShoalRenderer extends SwimRenderer {
  private seabed = new Seabed();
  /** The bed's still cells, drawn once into a layer the height of the bed, and drawn again only
   *  when the grid, the look or the cells the tiles cover change. */
  private bed = new OffscreenCanvas(1, 1);
  private bedTop = 0;
  private bedFresh = false;
  /** Each part of the bed's block and character. */
  private bedStyles = {} as Record<BedColour, { block: string; glyph: string }>;
  private weedStyles: { block: string; glyph: string }[] = [];

  constructor(canvas: OffscreenCanvas) {
    super(canvas, { shapes: SHAPES, kinds: KIND_LIST, tints: TINTS, palette: SHOAL_PALETTE });
  }

  protected looked(palette: SwimPalette | null) {
    this.bedFresh = false;
    if (!palette) return;
    const p = palette as ShoalPalette;
    const bed = p.seabed;
    // A part's block is its colour half faded into the deep water it stands in: its characters
    // stand out on it, as a shark's do.
    const deep = rgbOf(p.water[p.water.length - 1]!);
    const style = (c: Oklch, k = 0.5) => ({ block: css(mix(deep, rgbOf(c), k)), glyph: css(rgbOf(c)) });
    this.bedStyles = {
      // The sand less faded: half into blue water it went grey.
      sand: style(bed.sand, 0.75), rock: style(bed.rock), fan: style(bed.fan), brain: style(bed.brain),
      coral0: style(bed.corals[0]!), coral1: style(bed.corals[1]!), coral2: style(bed.corals[2]!),
    };
    this.weedStyles = bed.weeds.map((c) => style(c));
  }

  protected allocate(n: number) {
    super.allocate(n);
    this.seabed.build(this.cols, this.rows);
    this.bedFresh = false;
  }

  resize(width: number, height: number, dpr: number) {
    super.resize(width, height, dpr);
    this.bedFresh = false;
  }

  setBoxes(boxes: readonly Box[], seeThrough: boolean) {
    const moved = super.setBoxes(boxes, seeThrough);
    if (moved) this.bedFresh = false;
    return moved;
  }

  /** The sea bed: its still cells from their layer, drawn again first if anything changed, and
   *  the weed where it has swayed to. Nothing of it under a tile: like the fish, it is water. */
  protected drawUnder(t: number) {
    if (!this.colour) return;
    const { ctx, dpr, cols, rows, cw, ch, cover, seabed } = this;
    if (!this.bedFresh) this.paintBed();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bed, 0, Math.round(this.bedTop * ch * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const w of seabed.weeds) {
      const style = this.weedStyles[w.colour]!;
      let below = 0;
      for (let k = 0; k < w.height; k++) {
        const r = w.foot - k;
        const off = Seabed.sway(w, k, t);
        const c = w.c + off;
        const lean = off - below;
        below = off;
        if (r < 0 || c < 0 || c >= cols || r >= rows || cover[r * cols + c]) continue;
        const x = c * cw;
        const y = r * ch;
        // A thin blade: its foot a block, the rest bare characters.
        if (k < 2) {
          ctx.fillStyle = style.block;
          ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
        }
        ctx.fillStyle = style.glyph;
        const glyph = k === w.height - 1 ? "'" : lean < 0 ? "\\" : lean > 0 ? "/" : Math.sin(t * 0.7 + w.phase - k * 0.42) >= 0 ? ")" : "(";
        ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
      }
    }
  }

  private paintBed() {
    const { dpr, cols, cw, ch, cover, seabed } = this;
    this.bedFresh = true;
    let top = this.rows;
    for (const b of seabed.cells) top = Math.min(top, b.r);
    this.bedTop = top;
    const w = Math.max(1, Math.round(cols * cw * dpr));
    const h = Math.max(1, Math.round((this.rows - top) * ch * dpr));
    if (this.bed.width !== w || this.bed.height !== h) {
      this.bed.width = w;
      this.bed.height = h;
    }
    const g = this.bed.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setTransform(dpr, 0, 0, dpr, 0, -top * ch * dpr);
    g.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const b of seabed.cells) {
      if (cover[b.r * cols + b.c]) continue;
      const style = this.bedStyles[b.colour];
      if (b.block) {
        g.fillStyle = style.block;
        g.fillRect(b.c * cw + 1, b.r * ch + 1, cw - 1, ch - 1);
      }
      if (b.glyph === " ") continue;
      g.fillStyle = style.glyph;
      g.fillText(b.glyph, b.c * cw + cw / 2, b.r * ch + ch / 2 + 1);
    }
  }
}
