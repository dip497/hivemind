/**
 * Draws water and what swims in it, as a grid of ASCII cells: Shoal's sharks, Koi Pond's koi.
 *   1. the water: the theme's page with a faint cell grid, or the scene's own water (backdrop.ts)
 *   2. a wake field that diffuses where things swim, lighting the dots
 *   3. fish as minimal ASCII dashes, one per cell, glinting on hard turns
 *   4. the agents' creatures (spine.ts), cell by cell with supersampled edges: blocks shaded by
 *      the light, dense glyphs, and a few glints
 * A scene's renderer adds its own layers under and over them (a sea bed, lily pads).
 *
 * Ported from stackedlol/ascii-sharks (MIT, see shoal/LICENSE). The scene is drawn in the theme's
 * own two colours, the page and its text, mixed in RAMP steps that are worked out once per theme,
 * so a frame builds no colour strings. Each kind of creature leans a little toward its own cast
 * (the original's tints); the original's blue, cyan, red and shimmer colours are gone: colour in
 * Hivemind means something.
 *
 * On a dark theme a creature is light on the dark water, as in the original. On a light one it is
 * ink on paper: mid-grey blocks with darker characters in them, its edges fading to the page.
 *
 * With Colour on, the same tones are steps of the scene's own colours (its palette) in place of
 * the page and the text: its water with light coming down through it, fish in their colours and
 * each kind of creature in its own.
 */
import type { WaterLook } from "./backdrop";
import { ramp as rampOf, RAMP, rgbOf, type Oklch } from "./colour";
import { LookRenderer, themeRamp } from "./look";
import { clamp, hash3 } from "./math";
import { FLAG_BODY, FLAG_EDGE, FLAG_EYE, FLAG_FIN, FLAG_MARK, FLAG_RIDGE, SPINE_NODES, SpineRaster, type SpineShape } from "./spine";
import type { World } from "./world";

/** A scene's water in its own colours, and what swims in it. */
export interface SwimPalette extends WaterLook {
  /** Where every creature's ramp starts: its shadow on dark water, the water itself on light. */
  shadow: Oklch;
  /** Each kind's skin where the light is full on it (dark) or at its darkest ink (light). */
  kinds: Record<string, Oklch>;
  /** A kind's markings that are colours of their own (a koi's patches), by marking (1, 2 …). */
  marks?: Record<string, Oklch[]>;
  /** By species (the World's). */
  fish: Oklch[];
  /** The wake's dots at their brightest, and a bite's flash. */
  wake: Oklch;
  flash: Oklch;
  /** On light water, whether the creatures are bright on it, lit as on dark water, rather than
   *  ink on paper (Shoal's): a white koi is white. */
  bright?: boolean;
  /** How far a lit creature's skin is lifted from its shadow (`LIFT`): a koi's white is whiter. */
  lift?: { base: number; span: number };
}

/** What a scene's creatures are: their shapes, by kind, and how each is drawn. */
export interface SwimBook {
  shapes: Readonly<Record<string, SpineShape>>;
  /** The kinds, in a fixed order. */
  kinds: readonly string[];
  /** In the theme's colours, each kind's cast: how much of the red, green and blue it carries. */
  tints: Readonly<Record<string, readonly number[]>>;
  /** In the theme's colours, a kind's coloured markings (`SwimPalette.marks`) as shares of its
   *  skin's light: a koi's red patch mid-grey, its black spots dark. */
  monoMarks?: Readonly<Record<string, readonly number[]>>;
  /** In the theme's colours, a kind's skin as a share of the light (a black koi's), 1 if not set. */
  monoSkin?: Readonly<Record<string, number>>;
  palette: { dark: SwimPalette; light: SwimPalette };
}

const ALPHA_LEVELS = 6;
const FISH_LEVELS = [0.28, 0.42, 0.58, 0.74, 0.9];
/** How far toward the text colour the wake's dots go at their brightest. */
const WAKE_REACH = 0.5;
/**
 * How a light theme draws, in steps from the page (0) toward the text (1), matched to the
 * reference demo's tones. A shark's block goes from `base` at its faintest to `base + span` where
 * the original is brightest, its character `glyph` darker than its block and a glint `glint`
 * lighter; an edge is a faint block (`edge` to `edge + edgeSpan`) under a character `edgeGlyph`
 * darker. Eyes and markings keep the original's levels, so an eye is a grey ring on the page as
 * it is on black. The water is fainter than on a dark theme, where light on black needs more.
 */
const INK = {
  base: 0.02, span: 0.88, glyph: 0.24, glint: 0.18,
  edge: 0.05, edgeSpan: 0.12, edgeGlyph: 0.14,
  fish: 0.36, wake: 0.32,
};
/** Dark water in the scene's own colours is lighter than black, and a shark drawn at the plain
 *  levels sank into it: its skin is lifted to `base + span` of its levels, its eyes and markings
 *  kept dark on it. */
const LIFT = { base: 0.28, span: 0.8 };
/** How far toward the text a shark under a see-through tile goes, against one in open water: it
 *  is seen through the tile's tint, softened, behind the tile's text. */
const SOFT = 0.55;
/** How much of each kind's cast (TINTS) shows: enough to read as grey-blue or grey-brown, not
 *  as a colour, which in Hivemind says something. */
const CAST = 0.6;

// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const SKIN_RAMP = ":;t%SX8#@";
const FIN_GLYPHS = "%;tS:";
const RIDGE_GLYPHS = "@8%";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";

const MARK_GLYPHS = "#%@";

export abstract class SwimRenderer extends LookRenderer<SwimPalette> {
  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private bucketOf = new Uint8Array(0);
  private bucketOrder = new Int32Array(0);
  private bucketCounts = new Int32Array(ALPHA_LEVELS + 1);
  /** The page colour to the text colour for each kind of creature, leaning toward its cast. */
  private kindRamps: string[][] = [];
  /** And as pixels (ImageData's RGBA, little-endian), for what is drawn under a see-through tile. */
  private kindPixels: Uint32Array[] = [];
  /** Creatures are ink on paper: darker the more of them, on light water. */
  private ink = false;
  private wakeStyles: string[] = [];

  /** Each kind's coloured markings' ramps, and how lit each is against the skin. */
  private markRamps: { styles: string[]; pixels: Uint32Array; scale: number }[][] = [];
  /** How lit each kind's skin is drawn (`SwimBook.monoSkin`). */
  private kindScale: number[] = [];
  protected raster: SpineRaster;

  /** Cells holding a fish this frame (frame stamp); dots skip them. */
  private fishStamp = new Uint32Array(0);
  private frameId = 0;
  /** Fish cells bucketed by species (in colour) and brightness, so each bucket is one fillStyle. */
  private fishBuckets: number[][] = FISH_LEVELS.map(() => []);
  private fishStyles: string[] = [];

  constructor(canvas: OffscreenCanvas, private book: SwimBook) {
    super(canvas, book.palette);
    this.raster = new SpineRaster(book.shapes, Object.fromEntries(book.kinds.map((k, i) => [k, i])));
    this.setLook({ page: 0x000000, text: 0xffffff, colour: false });
  }

  protected styled() {
    const p = this.colour;
    if (p) this.colourStyles(p);
    else this.themeStyles();
    this.looked(p);
  }

  /** In the scene's own colours: every creature, fish, dot and flash a step of its palette. */
  private colourStyles(p: SwimPalette) {
    this.ink = this.light && !p.bright;
    // The middle of the water: what a fish, the wake and a flash fade into.
    const mid = rgbOf(p.water[1]!);
    const shadow = rgbOf(p.shadow);
    const kinds = this.book.kinds.map((k) => rampOf(shadow, rgbOf(p.kinds[k]!)));
    this.kindRamps = kinds.map((k) => k.styles);
    this.kindPixels = kinds.map((k) => k.pixels);
    this.markRamps = this.book.kinds.map((k) => (p.marks?.[k] ?? []).map((c) => ({ ...rampOf(shadow, rgbOf(c)), scale: 1 })));
    this.kindScale = this.book.kinds.map(() => 1);
    this.ramp = rampOf(mid, rgbOf(p.flash)).styles;
    const wake = rampOf(mid, rgbOf(p.wake)).styles;
    const reach = this.light ? INK.wake : WAKE_REACH;
    this.wakeStyles = Array.from({ length: ALPHA_LEVELS }, (_, l) => this.tone((reach * (l + 1)) / ALPHA_LEVELS, wake));
    this.fishStyles = p.fish.flatMap((c) => {
      const r = rampOf(mid, rgbOf(c)).styles;
      return FISH_LEVELS.map((a) => this.tone(0.3 + 0.7 * a, r));
    });
    this.fishBuckets = this.fishStyles.map(() => []);
  }

  /** The look changed: `palette` is the scene's own colours, or null for the theme's. A scene's
   *  own layers take theirs here. */
  protected looked(_palette: SwimPalette | null) {}

  /** Drawn after the water, before the fish and creatures (a sea bed): the transform is the
   *  device's own, 1:1. */
  protected drawUnder(_t: number) {}

  /** Drawn over the creatures (lily pads, ripples), in CSS pixels. */
  protected drawOver(_t: number) {}

  /** In the theme's colours: every colour the scene draws is a step from its page to its text, so
   *  a theme change is one call and a frame never builds a colour string. */
  private themeStyles() {
    this.ink = this.light;
    // A channel's weight is how fast it goes from the page toward the text: on light water more
    // red ink leaves a shark bluer, so a light theme takes the inverse of the original's tint.
    const ramp = (weights: readonly number[]) => themeRamp(this.page, this.text, weights);
    const kinds = this.book.kinds.map((k) => ramp(this.book.tints[k]!.map((c) => 1 + ((this.light ? 1 / c : c) - 1) * CAST)));
    this.kindRamps = kinds.map((k) => k.styles);
    this.kindPixels = kinds.map((k) => k.pixels);
    // A marking of its own colour is the kind's skin at its share of the light.
    this.markRamps = this.book.kinds.map((k, i) => (this.book.monoMarks?.[k] ?? []).map((scale) => ({ styles: kinds[i]!.styles, pixels: kinds[i]!.pixels, scale })));
    this.kindScale = this.book.kinds.map((k) => this.book.monoSkin?.[k] ?? 1);
    const wake = this.light ? INK.wake : WAKE_REACH;
    this.wakeStyles = Array.from({ length: ALPHA_LEVELS }, (_, l) => this.tone((wake * (l + 1)) / ALPHA_LEVELS));
    this.fishStyles = FISH_LEVELS.map((a) => this.tone(a * (this.light ? INK.fish : 0.9)));
    this.fishBuckets = FISH_LEVELS.map(() => []);
  }

  protected allocate(n: number) {
    this.energy = new Float32Array(n);
    this.energyTmp = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.bucketOf = new Uint8Array(n);
    this.bucketOrder = new Int32Array(n);
    this.raster.allocate(n);
    this.fishStamp = new Uint32Array(n);
  }

  render(world: World, dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = world.time;

    this.consumeEvents(world);
    this.raster.rasterize(world.swimmers, t, { cw: this.cw, ch, cols, rows: this.rows }, this.cover, this.seeThrough);
    this.depositWake(world);
    this.diffuse(dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.backdrop(t), 0, 0);
    this.drawUnder(t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.markFish(world);
    this.drawDots();

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    this.drawFish();
    this.drawCreatures(t);
    this.drawOver(t);
    if (this.softAny) this.drawSoft();
    // Flashes go over the creatures: a shark swims on over the spot it bit.
    this.drawHeat();
  }

  /** A creature's cell under a see-through tile, `t` toward the text as it would be drawn. */
  private softCell(i: number, t: number, pixels: Uint32Array) {
    this.softPixel(i, pixels[clamp(Math.round(t * SOFT * RAMP), 0, RAMP)]!);
  }

  // ── simulation → field ──────────────────────────────────────────────

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i]! + amount * (1 - d / (radius + 1)));
      }
    }
  }

  protected consumeEvents(world: World) {
    for (const e of world.events) {
      if (e.kind === "eat") {
        this.stamp(this.heat, e.x, e.y, 2, 1);
        this.stamp(this.energy, e.x, e.y, 3, 0.9);
      } else if (e.kind === "bite") {
        // A finished turn: a brighter flash at the mouth than a meal, and wider ripples round it.
        this.stamp(this.heat, e.x, e.y, 1, 1.6);
        this.stamp(this.energy, e.x, e.y, 5, 1.5);
      } else {
        this.stamp(this.energy, e.x, e.y, 6, 1.4);
      }
    }
    world.events.length = 0;
  }

  private depositWake(world: World) {
    const { energy } = this;
    for (const f of world.fish) {
      if (!f.alive) continue;
      const i = this.cellIndex(f.x, f.y);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i]! + 0.012 + f.alarm * 0.03);
    }
    for (const sh of world.swimmers) {
      // The tail sweeps the most water.
      for (let k = SPINE_NODES - 6; k < SPINE_NODES; k++) {
        const i = this.cellIndex(sh.nodes[k * 2]!, sh.nodes[k * 2 + 1]!);
        if (i >= 0) energy[i] = Math.min(1.6, energy[i]! + 0.05 + sh.speed * 0.0012);
      }
    }
    if (world.pointer.active) {
      this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
    }
  }

  /** Blur + decay so wakes spread out like ripples and fade. */
  private diffuse(dt: number) {
    const { cols, rows, energy, energyTmp: tmp, heat } = this;
    const decay = Math.exp(-dt * 1.5);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? energy[i - 1]! : energy[i]!;
        const rt = c < cols - 1 ? energy[i + 1]! : energy[i]!;
        const u = r > 0 ? energy[i - cols]! : energy[i]!;
        const d = r < rows - 1 ? energy[i + cols]! : energy[i]!;
        tmp[i] = (energy[i]! * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    this.energy = tmp;
    this.energyTmp = energy;
    const heatDecay = Math.exp(-dt * 2.2);
    for (let i = 0; i < heat.length; i++) heat[i] = heat[i]! * heatDecay;
  }

  // ── creatures ───────────────────────────────────────────────────────

  private drawCreatures(t: number) {
    const { ctx, cols, rows, cw, ch, cover } = this;
    const paper = this.ink;
    const { flag: sharkFlag, shade: sharkShade, key: sharkKey, depth: sharkDepth, kind: sharkKind, mark: sharkMark } = this.raster;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      if (!sharkFlag[i]) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cw;
      const y = row * ch;
      const key = sharkKey[i]!;
      const shade = sharkShade[i]!;
      const dim = 0.7 + 0.3 * sharkDepth[i]!;
      const kind = sharkKind[i]!;
      // A marking in a colour of its own (a koi's patch) is skin in that colour; a shark's dark
      // markings are drawn as markings.
      const own = sharkMark[i] ? this.markRamps[kind]![sharkMark[i]! - 1] : undefined;
      const ramp = own ? own.styles : this.kindRamps[kind]!;
      const pixels = own ? own.pixels : this.kindPixels[kind]!;
      const flag = own && sharkFlag[i] === FLAG_MARK ? FLAG_BODY : sharkFlag[i]!;

      // Glints re-roll on a staggered clock so the hide shimmers.
      const tick = Math.floor(t * 2.4 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);

      if (flag === FLAG_EDGE) {
        // Soft, anti-aliased silhouette: on dark water a light glyph alone, on light water a faint
        // block under it too, so the edge fades into the page.
        const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        const glyph = set[(key >>> 8) % set.length]!;
        if (cover[i]) {
          this.softCell(i, paper ? (INK.edge + INK.edgeSpan * shade) * dim : (((70 + shade * 80) * dim) / 255) * shade, pixels);
          continue;
        }
        if (paper) {
          const block = (INK.edge + INK.edgeSpan * shade) * dim;
          ctx.fillStyle = this.tone(block, ramp);
          ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
          ctx.fillStyle = this.tone(block + INK.edgeGlyph, ramp);
        } else ctx.fillStyle = this.tone(((70 + shade * 80) * dim) / 255, ramp);
        ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
        continue;
      }

      let level: number;
      let glyph: string;
      if (flag === FLAG_RIDGE) {
        level = 226;
        glyph = RIDGE_GLYPHS[(key >>> 8) % RIDGE_GLYPHS.length]!;
      } else if (flag === FLAG_EYE) {
        level = 12;
        glyph = "o";
      } else if (flag === FLAG_MARK) {
        level = 24 + shade * 22;
        glyph = MARK_GLYPHS[(key >>> 8) % MARK_GLYPHS.length]!;
      } else if (flag === FLAG_FIN) {
        level = 40 + shade * 120;
        glyph = FIN_GLYPHS[(key >>> 8) % FIN_GLYPHS.length]!;
      } else {
        level = 46 + shade * 160;
        const jitter = ((key >>> 4) % 3) - 1;
        glyph = SKIN_RAMP[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN_RAMP.length - 1)]!;
      }
      // Levels are on the original's 0–255 scale: how much light the skin gives back.
      const lit = (level * dim * (flag === FLAG_EYE ? 1 : own ? own.scale : this.kindScale[kind]!)) / 255;
      let block: number;
      let ink: number;
      if (paper) {
        // Ink on paper: the more of the shark, the darker its block, and its character darker still.
        if (flag === FLAG_EYE) { block = lit; ink = 0.62; }
        else if (flag === FLAG_MARK) { block = lit; ink = 0.27; }
        else {
          block = INK.base + INK.span * lit;
          ink = roll < 0.04 ? Math.max(0, block - INK.glint) : block + INK.glyph;
        }
      } else {
        const lift = this.colour?.lift ?? LIFT;
        block = this.colour && flag !== FLAG_EYE && flag !== FLAG_MARK ? lift.base + lift.span * lit : lit;
        if (flag === FLAG_EYE) ink = 0.62;
        else if (flag === FLAG_MARK) ink = 0.27;
        else if (roll < 0.05) ink = 1;
        else ink = shade > 0.55 ? 0.05 : 0.1;
      }
      if (cover[i]) {
        this.softCell(i, block, pixels);
        continue;
      }
      ctx.fillStyle = this.tone(block, ramp);
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      ctx.fillStyle = this.tone(ink, ramp);
      ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
    }
  }

  // ── fish, dots, heat ────────────────────────────────────────────────

  /**
   * Snap each fish to a cell and bucket it by brightness: far fish are dim,
   * near fish brighter, and turning or panicking fish glint. Nearer fish
   * claim a cell first when two land in the same one.
   */
  private markFish(world: World) {
    const { fishStamp, fishBuckets } = this;
    const sharkFlag = this.raster.flag;
    const frame = ++this.frameId;
    for (const bucket of fishBuckets) bucket.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const f of world.fish) {
        if (!f.alive || (f.depth > 0.78 ? 0 : 1) !== pass) continue;
        const i = this.cellIndex(f.x, f.y);
        if (i < 0 || fishStamp[i]! === frame || sharkFlag[i]! || this.cover[i]) continue;
        fishStamp[i] = frame;
        const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1);
        const v = 0.3 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm);
        const level = clamp(Math.floor(v * FISH_LEVELS.length), 0, FISH_LEVELS.length - 1);
        fishBuckets[(this.colour ? f.species * FISH_LEVELS.length : 0) + level]!.push(i);
      }
    }
  }

  private drawFish() {
    const { ctx, cw, ch, cols, fishBuckets } = this;
    for (let b = 0; b < fishBuckets.length; b++) {
      const bucket = fishBuckets[b]!;
      if (!bucket.length) continue;
      ctx.fillStyle = this.fishStyles[b]!;
      for (const i of bucket) {
        ctx.fillText("-", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
      }
    }
  }

  private drawHeat() {
    const { ctx, heat, cols, cw, ch } = this;
    for (let i = 0; i < heat.length; i++) {
      const h = heat[i]!;
      if (h < 0.08 || this.cover[i]) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      // A bite flashes in the text colour and fades back to the page.
      ctx.fillStyle = this.tone(h > 0.5 ? Math.min(1, h) : h * 1.1);
      ctx.fillText(h > 0.6 ? "*" : "·", col * cw + cw / 2, row * ch + ch / 2 + 1);
    }
  }

  /** Dots light up where the wake is strong, bucketed by brightness so each bucket is one fillStyle. */
  private drawDots() {
    const { ctx, cols, rows, cw, ch, energy, fishStamp, frameId } = this;
    const sharkFlag = this.raster.flag;
    const { bucketOf, bucketOrder, bucketCounts } = this;
    const n = cols * rows;
    const SKIP = bucketCounts.length - 1;
    bucketCounts.fill(0);

    for (let i = 0; i < n; i++) {
      const e = energy[i]!;
      if (sharkFlag[i]! || fishStamp[i]! === frameId || e < 0.45 || this.cover[i]) {
        bucketOf[i] = SKIP;
        continue;
      }
      const bucket = clamp(Math.floor((e - 0.45) * 5), 0, ALPHA_LEVELS - 1);
      bucketOf[i] = bucket;
      bucketCounts[bucket] = bucketCounts[bucket]! + 1;
    }

    // Counting sort cells by bucket.
    const starts = new Int32Array(bucketCounts.length);
    for (let b = 1; b < bucketCounts.length; b++) starts[b] = starts[b - 1]! + bucketCounts[b - 1]!;
    const cursor = starts.slice();
    for (let i = 0; i < n; i++) {
      const b = bucketOf[i]!;
      if (b === SKIP) continue;
      const at = cursor[b]!;
      cursor[b] = at + 1;
      bucketOrder[at] = i;
    }

    const size = Math.max(2, Math.round(cw * 0.19)) + 1;
    for (let b = 0; b < SKIP; b++) {
      const count = bucketCounts[b]!;
      if (!count) continue;
      ctx.fillStyle = this.wakeStyles[b]!;
      const start = starts[b]!;
      for (let k = start; k < start + count; k++) {
        const i = bucketOrder[k]!;
        const col = i % cols;
        const row = (i / cols) | 0;
        // Sit the dot low-right in its cell, as in the reference.
        ctx.fillRect(Math.round(col * cw + cw * 0.66 - size / 2), Math.round(row * ch + ch * 0.64 - size / 2), size, size);
      }
    }
  }
}
