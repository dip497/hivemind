/**
 * The grid of character cells every scene draws in, and what it shares: the cells' size, the
 * backdrop painted once per size and look, which cells the tiles and panels cover, and the soft
 * picture of what is under the see-through ones. A scene's renderer extends it with its creatures.
 */
import { clamp } from "./math";
import type { Box } from "./scene";

/** Which cells (`cols` by `rows`, each `cw` by `ch`) are under a tile or a panel, or in a gap
 *  narrower than a cell between two: a cell whose centre is within half a cell of a box. Nothing is
 *  drawn there, so a creature passing under a block of tiles does not show through its seams. */
export function coveredCells(boxes: readonly Box[], cols: number, rows: number, cw: number, ch: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(cols * rows);
  for (const b of boxes) {
    const c0 = Math.max(0, Math.ceil(b.x0 / cw - 1));
    const c1 = Math.min(cols - 1, Math.floor(b.x1 / cw));
    const r0 = Math.max(0, Math.ceil(b.y0 / ch - 1));
    const r1 = Math.min(rows - 1, Math.floor(b.y1 / ch));
    for (let r = r0; r <= r1; r++) out.fill(1, r * cols + c0, r * cols + c1 + 1);
  }
  return out;
}

/** A faint cell grid, snapped to device pixels. */
export function paintGrid(g: OffscreenCanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, dpr: number, stroke: string) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= Math.ceil(W / cw); c++) {
    const x = Math.round(c * cw * dpr) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H * dpr);
  }
  for (let r = 0; r <= Math.ceil(H / ch); r++) {
    const y = Math.round(r * ch * dpr) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W * dpr, y);
  }
  g.stroke();
}

export abstract class CellRenderer {
  protected ctx: OffscreenCanvasRenderingContext2D;
  /** The backdrop (`paintBackground`), painted once per size and look and copied in each frame;
   *  `bgVersion` counts its paintings. */
  protected bg = new OffscreenCanvas(1, 1);
  protected bgVersion = 0;
  protected dpr = 1;
  protected width = 0;
  protected height = 0;
  protected cw = 12;
  protected ch = 18;
  protected cols = 0;
  protected rows = 0;
  protected fontFamily = "ui-monospace, Menlo, monospace";

  /** The tiles and panels as last told, and the cells they cover (`coveredCells`). */
  protected boxes: readonly Box[] = [];
  protected cover = new Uint8Array(0);
  /** The tiles are see-through: a creature under one is drawn soft, not left out. */
  protected seeThrough = false;
  /** One pixel a cell, what is under the see-through tiles this frame, drawn scaled up and smoothed
   *  over them: a creature behind frosted glass. */
  private soft = new OffscreenCanvas(1, 1);
  private softCtx: OffscreenCanvasRenderingContext2D | null = null;
  private softData: ImageData | null = null;
  private softPixels = new Uint32Array(0);
  protected softAny = false;
  /** The cells this frame's soft pixels span, so only that much is drawn scaled up. */
  private softC0 = 0;
  private softC1 = 0;
  private softR0 = 0;
  private softR1 = 0;

  constructor(protected canvas: OffscreenCanvas) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
  }

  get cellWidth() {
    return this.cw;
  }

  get cellHeight() {
    return this.ch;
  }

  setFontFamily(family: string) {
    if (family) this.fontFamily = family;
  }

  /** Paint the backdrop into `bg`, at its size. */
  protected abstract paintBackground(): void;

  /** The grid has a new number of cells, `n`: the scene's per-cell buffers are made again. */
  protected abstract allocate(n: number): void;

  resize(width: number, height: number, dpr: number) {
    const prevCols = this.cols;
    const prevRows = this.rows;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    // Cells from the shorter side, as the creatures are: a shark is some 48 cells long, as in the
    // original's demo, on any shape of window (from the width alone, a wide one drew it coarser).
    this.cw = clamp(Math.round(Math.min(width, height) / 110), 7, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;

    if (this.cols !== prevCols || this.rows !== prevRows) {
      this.allocate(this.cols * this.rows);
      this.soft = new OffscreenCanvas(this.cols, this.rows);
      this.softCtx = this.soft.getContext("2d");
      this.softData = this.softCtx?.createImageData(this.cols, this.rows) ?? null;
      this.softPixels = this.softData ? new Uint32Array(this.softData.data.buffer) : new Uint32Array(0);
    }
    this.cover = coveredCells(this.boxes, this.cols, this.rows, this.cw, this.ch);
    this.repaintBackground();
  }

  /** Paint the backdrop again, counting it. */
  protected repaintBackground() {
    this.bgVersion++;
    this.paintBackground();
  }

  /** Where the tiles and panels are on the screen, and whether the tiles are see-through: a
   *  creature under a solid one is not drawn, one under a see-through one is drawn soft. Told once a
   *  second, and each frame while the canvas moves; the cells are worked out again only when one has
   *  moved. Whether they were. */
  setBoxes(boxes: readonly Box[], seeThrough: boolean): boolean {
    const same = boxes.length === this.boxes.length && boxes.every((b, i) => {
      const o = this.boxes[i]!;
      return b.x0 === o.x0 && b.y0 === o.y0 && b.x1 === o.x1 && b.y1 === o.y1;
    });
    this.boxes = boxes;
    this.seeThrough = seeThrough;
    if (!same && this.cols) this.cover = coveredCells(boxes, this.cols, this.rows, this.cw, this.ch);
    return !same;
  }

  protected cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  /** What is under the see-through tiles, one pixel a cell, scaled up smoothly over them: soft,
   *  with no characters for the tile's own text to run through. */
  protected drawSoft() {
    const { ctx, soft, softCtx, softData, cols, rows, cw, ch } = this;
    this.softAny = false;
    if (!softCtx || !softData) return;
    // Only the cells the soft pixels span, and one more round them for the smoothing to fade into.
    const c0 = Math.max(0, this.softC0 - 1);
    const r0 = Math.max(0, this.softR0 - 1);
    const w = Math.min(cols, this.softC1 + 2) - c0;
    const h = Math.min(rows, this.softR1 + 2) - r0;
    softCtx.putImageData(softData, 0, 0, c0, r0, w, h);
    ctx.save();
    ctx.beginPath();
    for (const b of this.boxes) ctx.rect(b.x0 - cw / 2, b.y0 - ch / 2, b.x1 - b.x0 + cw, b.y1 - b.y0 + ch);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    // Plain bilinear: softer than the "high" filter, which rings round a dark fin, and a quarter
    // of its cost (2.3 against 6 ms a frame at 1440×900 in software, 7 against 26 at 2×).
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(soft, c0, r0, w, h, c0 * cw, r0 * ch, w * cw, h * ch);
    ctx.restore();
    for (let r = r0; r < r0 + h; r++) this.softPixels.fill(0, r * cols + c0, r * cols + c0 + w);
  }

  /** Cell `i`, under a see-through tile, is this pixel (`pixelOf`) this frame. */
  protected softPixel(i: number, pixel: number) {
    this.softPixels[i] = pixel;
    const c = i % this.cols;
    const r = (i / this.cols) | 0;
    if (!this.softAny) {
      this.softAny = true;
      this.softC0 = this.softC1 = c;
      this.softR0 = this.softR1 = r;
      return;
    }
    if (c < this.softC0) this.softC0 = c;
    else if (c > this.softC1) this.softC1 = c;
    if (r < this.softR0) this.softR0 = r;
    else if (r > this.softR1) this.softR1 = r;
  }
}
