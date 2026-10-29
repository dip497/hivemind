/**
 * Draws the World as a grid of ASCII cells:
 *   1. a cell grid on the theme's page colour
 *   2. a wake field that diffuses where things swim, lighting the dots
 *   3. fish as minimal ASCII dashes, one per cell, glinting on hard turns
 *   4. sharks rasterised cell-by-cell with supersampled edges: blocks
 *      shaded by the light, dense glyphs, and a few glints
 *
 * Ported from stackedlol/ascii-sharks (MIT, see LICENSE here). The scene is drawn in the theme's
 * own two colours, the page and its text, mixed in RAMP steps that are worked out once per theme,
 * so a frame builds no colour strings. Each kind of shark leans a little toward its own cast (the
 * original's tints); the original's blue, cyan, red and shimmer colours are gone: colour in
 * Hivemind means something.
 *
 * On a dark theme a shark is light on the dark water, as in the original. On a light one it is
 * ink on paper: mid-grey blocks with darker characters in them, its edges fading to the page.
 *
 * With Colour on, the same tones are steps of the scene's own colours (palette.ts) in place of
 * the page and the text: a reef's water with light coming down through it, a sea bed, fish in
 * their colours and each kind of shark in its skin's.
 */
import { paintWater, Shafts, waterOf, type Water } from "../backdrop";
import { CellRenderer, paintGrid } from "../cells";
import { css, mix, ramp as rampOf, RAMP, rgbOf, type Oklch } from "../colour";
import { clamp, hash3, smoothstep } from "../math";
import { lightOf } from "../palette";
import type { Box, Look } from "../scene";
import { SHOAL_PALETTE, type ShoalPalette } from "./palette";
import { Seabed, type BedColour } from "./seabed";
import { SHARK_NODES, type Shark, type SharkKind, type World } from "./world";

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
  fish: 0.36, wake: 0.32, grid: 0.015,
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

const FLAG_BODY = 1;
const FLAG_EDGE = 2;
const FLAG_FIN = 3;
const FLAG_RIDGE = 4;
const FLAG_EYE = 5;
/** Dark skin markings: tiger bars, zebra-shark spots. */
const FLAG_MARK = 6;
const MARK_GLYPHS = "#%@";

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];

/** Classic top-down half-width at s ∈ [0, 1] (snout → tail), as a fraction of length. */
function classicHalfWidth(s: number) {
  if (s < 0.13) return 0.09 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.95);
  if (s < 0.3) return 0.09 + 0.016 * smoothstep(0.13, 0.3, s);
  if (s < 0.84) return 0.019 + 0.087 * Math.pow(1 - (s - 0.3) / 0.54, 1.25);
  const k = (s - 0.84) / 0.16;
  return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
}

/** Body outline and fin layout per species. All values are fractions of length. */
interface SharkShape {
  halfWidth: (s: number) => number;
  /** Pectoral fin: leading root, trailing root, tip position along the body, and reach. */
  pectoral: [number, number, number, number];
  /** Notched (falcate) trailing edge on the pectorals. */
  falcate: boolean;
  /** Pelvic fins: leading root, trailing root, tip, reach. */
  pelvic: [number, number, number, number];
  /** Forked caudal fin reach, or 0 when the tail is a ribbon (zebra shark). */
  caudal: number;
  dorsal: [number, number];
  secondDorsal: [number, number];
  /**
   * Hammerheads' cephalofoil: half-span, how far its tips sweep back, its depth, and the
   * notch in the middle of the front edge. All fractions of length; absent for other sharks.
   */
  head?: { span: number; sweep: number; depth: number; notch: number };
  /** null when the eyes sit somewhere else (hammerhead: on the cephalofoil tips). */
  eye: [number, number] | null;
  gills: [number, number];
}

const SHAPES: Record<SharkKind, SharkShape> = {
  classic: {
    halfWidth: classicHalfWidth,
    pectoral: [0.15, 0.43, 0.55, 0.26],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.085,
    dorsal: [0.33, 0.47],
    secondDorsal: [0.71, 0.76],
    eye: [0.1, 0.14],
    gills: [0.19, 0.29],
  },
  // Slim neck under a wide, swept-back cephalofoil (drawn in sampleShark),
  // tall first dorsal, long upper tail lobe. Bronze-olive grey.
  hammerhead: {
    halfWidth: (s) => {
      if (s < 0.06) return 0.045;
      if (s < 0.3) return 0.045 + 0.061 * smoothstep(0.06, 0.3, s);
      return classicHalfWidth(s) * 0.92;
    },
    head: { span: 0.17, sweep: 0.035, depth: 0.09, notch: 0 },
    pectoral: [0.17, 0.4, 0.5, 0.22],
    falcate: true,
    pelvic: [0.56, 0.63, 0.67, 0.075],
    caudal: 0.11,
    dorsal: [0.28, 0.44],
    secondDorsal: [0.7, 0.74],
    eye: null,
    gills: [0.16, 0.26],
  },
  // Blunt, square snout on a heavy body; barred back. Warm grey-brown.
  tiger: {
    halfWidth: (s) => {
      if (s < 0.13) return 0.1 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.45);
      if (s < 0.3) return 0.1 + 0.014 * smoothstep(0.13, 0.3, s);
      if (s < 0.84) return 0.019 + 0.095 * Math.pow(1 - (s - 0.3) / 0.54, 1.2);
      const k = (s - 0.84) / 0.16;
      return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
    },
    pectoral: [0.15, 0.42, 0.53, 0.25],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.095,
    dorsal: [0.33, 0.46],
    secondDorsal: [0.71, 0.75],
    eye: [0.08, 0.12],
    gills: [0.19, 0.28],
  },
  // Short rounded head, body done by half-length, then a long ribbon of a
  // tail fin. Broad rounded pectorals, spotted sandy skin.
  zebra: {
    halfWidth: (s) => {
      if (s < 0.1) return 0.075 * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.7);
      if (s < 0.28) return 0.075 + 0.025 * smoothstep(0.1, 0.28, s);
      if (s < 0.55) return 0.022 + 0.078 * Math.pow(1 - (s - 0.28) / 0.27, 1.1);
      const k = (s - 0.55) / 0.45;
      return 0.022 * (1 - k * k) + 0.012 * Math.sin(k * Math.PI);
    },
    pectoral: [0.12, 0.3, 0.36, 0.19],
    falcate: false,
    pelvic: [0.42, 0.48, 0.51, 0.065],
    caudal: 0,
    dorsal: [0.36, 0.44],
    secondDorsal: [0.49, 0.53],
    eye: [0.06, 0.09],
    gills: [0.13, 0.2],
  },
  // Great hammerhead: a broader, nearly straight-edged cephalofoil with a notch at the centre,
  // a towering sickle first dorsal (drawn long and bright from above), and a cooler slate skin.
  greathammer: {
    halfWidth: (s) => {
      if (s < 0.05) return 0.04;
      if (s < 0.3) return 0.04 + 0.07 * smoothstep(0.05, 0.3, s);
      return classicHalfWidth(s) * 0.95;
    },
    head: { span: 0.21, sweep: 0.006, depth: 0.085, notch: 0.014 },
    pectoral: [0.16, 0.38, 0.49, 0.24],
    falcate: true,
    pelvic: [0.55, 0.62, 0.67, 0.085],
    caudal: 0.13,
    dorsal: [0.24, 0.45],
    secondDorsal: [0.68, 0.74],
    eye: null,
    gills: [0.15, 0.25],
  },
  // Shortfin mako: a long conical snout, a torpedo body that narrows hard to the tail stalk,
  // and a tall crescent tail. Metallic indigo back.
  mako: {
    halfWidth: (s) => {
      if (s < 0.17) return 0.088 * Math.pow(Math.sin(((s / 0.17) * Math.PI) / 2), 1.5);
      if (s < 0.32) return 0.088 + 0.012 * smoothstep(0.17, 0.32, s);
      if (s < 0.86) return 0.014 + 0.086 * Math.pow(1 - (s - 0.32) / 0.54, 1.45);
      const k = (s - 0.86) / 0.14;
      return 0.014 * (1 - k) + 0.01 * Math.sin(k * Math.PI);
    },
    pectoral: [0.18, 0.4, 0.5, 0.21],
    falcate: true,
    pelvic: [0.58, 0.64, 0.68, 0.06],
    caudal: 0.13,
    dorsal: [0.34, 0.45],
    secondDorsal: [0.76, 0.79],
    eye: [0.11, 0.15],
    gills: [0.2, 0.3],
  },
  // Thresher: a compact body over the front half, then the upper tail lobe as a long whip
  // that's as long as the shark itself. Big eyes, long sickle pectorals, bronze-violet skin.
  thresher: {
    halfWidth: (s) => {
      if (s < 0.08) return 0.07 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.75);
      if (s < 0.2) return 0.07 + 0.02 * smoothstep(0.08, 0.2, s);
      if (s < 0.48) return 0.012 + 0.078 * Math.pow(1 - (s - 0.2) / 0.28, 1.3);
      // The whip: thin, with a slight sickle swell before it tapers out.
      const k = (s - 0.48) / 0.52;
      return 0.012 * (1 - k) + 0.006 * Math.sin(k * Math.PI * 0.9) + 0.002;
    },
    pectoral: [0.12, 0.27, 0.36, 0.2],
    falcate: true,
    pelvic: [0.37, 0.41, 0.44, 0.045],
    caudal: 0,
    dorsal: [0.24, 0.32],
    secondDorsal: [0.45, 0.47],
    eye: [0.05, 0.1],
    gills: [0.11, 0.18],
  },
  // Nurse shark: a blunt, broad head, a heavy flattened body with both dorsals set far back,
  // rounded paddle pectorals, and a long low tail with no lower lobe. Tawny brown.
  nurse: {
    halfWidth: (s) => {
      if (s < 0.08) return 0.085 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.4);
      if (s < 0.3) return 0.085 + 0.02 * smoothstep(0.08, 0.3, s);
      if (s < 0.72) return 0.022 + 0.083 * Math.pow(1 - (s - 0.3) / 0.42, 1.1);
      const k = (s - 0.72) / 0.28;
      return 0.022 * (1 - k * k) + 0.014 * Math.sin(k * Math.PI);
    },
    pectoral: [0.16, 0.34, 0.4, 0.17],
    falcate: false,
    pelvic: [0.45, 0.52, 0.55, 0.075],
    caudal: 0,
    dorsal: [0.5, 0.58],
    secondDorsal: [0.63, 0.69],
    eye: [0.05, 0.075],
    gills: [0.14, 0.22],
  },
};

/** Each kind's cast, from the original: how much of the red, green and blue it carries. */
const TINTS: Record<SharkKind, [number, number, number]> = {
  classic: [0.92, 0.97, 1.05],
  hammerhead: [0.96, 0.98, 0.9],
  tiger: [1.02, 0.95, 0.84],
  zebra: [1.08, 0.97, 0.74],
  greathammer: [0.86, 0.93, 1.02],
  mako: [0.78, 0.9, 1.2],
  thresher: [1.0, 0.9, 1.08],
  nurse: [1.1, 0.96, 0.76],
};
const KIND_LIST = Object.keys(TINTS) as SharkKind[];
const KIND_INDEX = Object.fromEntries(KIND_LIST.map((k, i) => [k, i])) as Record<SharkKind, number>;

function inTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export class AsciiRenderer extends CellRenderer {
  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private bucketOf = new Uint8Array(0);
  private bucketOrder = new Int32Array(0);
  private bucketCounts = new Int32Array(ALPHA_LEVELS + 1);
  /** RAMP + 1 opaque colours, the page colour to the text colour (setColours). */
  private ramp: string[] = [];
  /** The same for each kind of shark (KIND_LIST), leaning toward its cast. */
  private kindRamps: string[][] = [];
  /** And as pixels (ImageData's RGBA, little-endian), for what is drawn under a see-through tile. */
  private kindPixels: Uint32Array[] = [];
  /** The page is lighter than the text. */
  private light = false;
  private wakeStyles: string[] = [];

  private sharkFlag = new Uint8Array(0);
  private sharkShade = new Float32Array(0);
  private sharkKey = new Uint32Array(0);
  private sharkDepth = new Float32Array(0);
  private sharkKind = new Uint8Array(0);
  private spine = new Float32Array(SHARK_NODES * 2);
  private arc = new Float32Array(SHARK_NODES);
  private arcTotal = 1;
  private shape = SHAPES.classic;
  private sharkId = 0;
  private finTipLeft = 0;
  private finTipRight = 0;
  // Scratch outputs of sampleShark(), to avoid allocating per sample.
  private hitFlag = 0;
  private hitShade = 0;
  private hitS = 0;
  private hitV = 0;
  /** How far inside the body's outline the last hit was: 0 on a fin or the head. */
  private hitInside = 0;
  /** Whether the last sample was within some segment's reach (`segReach`): when not, no point
   *  within half a cell of it can be on the shark. */
  private hitNear = false;
  /** The spine's segments, worked out once per shark per frame: each one's run and length². */
  private segDx = new Float64Array(SHARK_NODES);
  private segDy = new Float64Array(SHARK_NODES);
  private segLen2 = new Float64Array(SHARK_NODES);
  /** How far each segment's part of the shark reaches from it, sideways (`segmentReach`). */
  private segReach = new Float64Array(SHARK_NODES);

  /** Cells holding a fish this frame (frame stamp); dots skip them. */
  private fishStamp = new Uint32Array(0);
  private frameId = 0;
  /** Fish cells bucketed by species (in colour) and brightness, so each bucket is one fillStyle. */
  private fishBuckets: number[][] = FISH_LEVELS.map(() => []);
  private fishStyles: string[] = [];

  /** Drawn in the scene's own colours (`setLook`): its palette, and the water it makes. */
  private colour: ShoalPalette | null = null;
  private water: Water | null = null;
  private shafts = new Shafts();
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
    super(canvas);
    this.setColours(0x000000, 0xffffff);
  }

  /** The theme's page and text colours, and whether the scene is drawn in its own instead. */
  setLook(look: Look) {
    if (!look.colour) {
      this.colour = null;
      this.water = null;
      this.shafts.setLook(null);
      this.setColours(look.page, look.text);
      return;
    }
    this.light = lightOf(look.page, look.text);
    const p = (this.colour = SHOAL_PALETTE[this.light ? "light" : "dark"]);
    this.water = waterOf(p);
    this.shafts.setLook(this.water.shafts);
    // The middle of the water: what a fish, the wake and a flash fade into.
    const mid = rgbOf(p.water[1]!);
    const shadow = rgbOf(p.shadow);
    const kinds = KIND_LIST.map((k) => rampOf(shadow, rgbOf(p.kinds[k])));
    this.kindRamps = kinds.map((k) => k.styles);
    this.kindPixels = kinds.map((k) => k.pixels);
    this.ramp = rampOf(mid, rgbOf(p.flash)).styles;
    const wake = rampOf(mid, rgbOf(p.wake)).styles;
    const reach = this.light ? INK.wake : WAKE_REACH;
    this.wakeStyles = Array.from({ length: ALPHA_LEVELS }, (_, l) => this.tone((reach * (l + 1)) / ALPHA_LEVELS, wake));
    this.fishStyles = p.fish.flatMap((c) => {
      const r = rampOf(mid, rgbOf(c)).styles;
      return FISH_LEVELS.map((a) => this.tone(0.3 + 0.7 * a, r));
    });
    this.fishBuckets = this.fishStyles.map(() => []);
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
    this.bedFresh = false;
    if (this.cols) this.repaintBackground();
  }

  /** The theme's page and text colours, as 0xRRGGBB. Every colour the scene draws is a step
   *  between them, so a theme change is one call and a frame never builds a colour string. */
  private setColours(page: number, text: number) {
    const ch = (c: number, k: number) => (c >> k) & 255;
    const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
    const luma = (c: number) => 0.2126 * ch(c, 16) + 0.7152 * ch(c, 8) + 0.0722 * ch(c, 0);
    this.light = luma(page) > luma(text);
    // A channel's weight is how fast it goes from the page toward the text: on light water more
    // red ink leaves a shark bluer, so a light theme takes the inverse of the original's tint.
    const ramp = ([wr, wg, wb]: readonly number[]) => {
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
    };
    this.ramp = ramp([1, 1, 1]).styles;
    const kinds = KIND_LIST.map((k) => ramp(TINTS[k].map((c) => 1 + ((this.light ? 1 / c : c) - 1) * CAST)));
    this.kindRamps = kinds.map((k) => k.styles);
    this.kindPixels = kinds.map((k) => k.pixels);
    const wake = this.light ? INK.wake : WAKE_REACH;
    this.wakeStyles = Array.from({ length: ALPHA_LEVELS }, (_, l) => this.tone((wake * (l + 1)) / ALPHA_LEVELS));
    this.fishStyles = FISH_LEVELS.map((a) => this.tone(a * (this.light ? INK.fish : 0.9)));
    this.fishBuckets = FISH_LEVELS.map(() => []);
    if (this.cols) this.repaintBackground();
  }

  /** The step `t` (0 page … 1 text) of a ramp, the plain one by default. */
  private tone(t: number, ramp = this.ramp) {
    return ramp[clamp(Math.round(t * RAMP), 0, RAMP)]!;
  }

  protected allocate(n: number) {
    this.energy = new Float32Array(n);
    this.energyTmp = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.bucketOf = new Uint8Array(n);
    this.bucketOrder = new Int32Array(n);
    this.sharkFlag = new Uint8Array(n);
    this.sharkShade = new Float32Array(n);
    this.sharkKey = new Uint32Array(n);
    this.sharkDepth = new Float32Array(n);
    this.sharkKind = new Uint8Array(n);
    this.fishStamp = new Uint32Array(n);
    this.seabed.build(this.cols, this.rows);
    this.bedFresh = false;
  }

  resize(width: number, height: number, dpr: number) {
    super.resize(width, height, dpr);
    this.shafts.resize(width, height);
    this.bedFresh = false;
  }

  setBoxes(boxes: readonly Box[], seeThrough: boolean) {
    const moved = super.setBoxes(boxes, seeThrough);
    if (moved) this.bedFresh = false;
    return moved;
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
    paintGrid(g, W, H, cw, ch, dpr, this.tone(this.light ? INK.grid : 0.055));
  }

  render(world: World, dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = world.time;

    this.consumeEvents(world);
    this.rasterizeSharks(world.sharks, t);
    this.depositWake(world);
    this.diffuse(dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.colour ? this.shafts.backdrop(this.bg, this.bgVersion, t, dpr) : this.bg, 0, 0);
    if (this.colour) this.drawBed(t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.markFish(world);
    this.drawDots();

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    this.drawFish();
    this.drawSharks(t);
    if (this.softAny) this.drawSoft();
    // Flashes go over the sharks: a shark swims on over the spot it bit.
    this.drawHeat();
  }

  /** The sea bed: its still cells from their layer, drawn again first if anything changed, and
   *  the weed where it has swayed to. Nothing of it under a tile: like the fish, it is water. */
  private drawBed(t: number) {
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

  /** A shark's cell under a see-through tile, `t` toward the text as it would be drawn. */
  private softCell(i: number, t: number, kind: number) {
    this.softPixel(i, this.kindPixels[kind]![clamp(Math.round(t * SOFT * RAMP), 0, RAMP)]!);
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

  private consumeEvents(world: World) {
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
    for (const sh of world.sharks) {
      // The tail sweeps the most water.
      for (let k = SHARK_NODES - 6; k < SHARK_NODES; k++) {
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

  // ── sharks ──────────────────────────────────────────────────────────

  /**
   * Classify one point against the current shark (spine/arc already built).
   * Body coordinates: s along the spine (0 snout → 1 tail), v across it.
   * Writes hit* fields and returns whether the point is on the shark.
   */
  private sampleShark(px: number, py: number, L: number) {
    const { spine, arc } = this;
    const N = SHARK_NODES;
    const { segDx, segDy, segLen2 } = this;
    const { segReach } = this;
    let best = Infinity;
    let bestK = 0;
    let bestU = 0;
    let near = false;
    for (let k = 0; k < N - 1; k++) {
      const ax = spine[k * 2]!;
      const ay = spine[k * 2 + 1]!;
      const sx = segDx[k]!;
      const sy = segDy[k]!;
      const u = clamp(((px - ax) * sx + (py - ay) * sy) / segLen2[k]!, 0, 1);
      const qx = ax + sx * u;
      const qy = ay + sy * u;
      const d2 = (px - qx) ** 2 + (py - qy) ** 2;
      if (d2 <= segReach[k]! * segReach[k]!) near = true;
      if (d2 < best) {
        best = d2;
        bestK = k;
        bestU = u;
      }
    }
    // Where along the body the nearest point is, which side of the spine, and the normal there.
    const sx = segDx[bestK]!;
    const sy = segDy[bestK]!;
    const len = Math.sqrt(segLen2[bestK]!);
    const bestS = (arc[bestK]! + bestU * len) / this.arcTotal;
    const bestSign = sx * (py - spine[bestK * 2 + 1]!) - sy * (px - spine[bestK * 2]!) >= 0 ? 1 : -1;
    const bestNx = (-sy / len) * bestSign;
    const bestNy = (sx / len) * bestSign;

    const a = Math.sqrt(best);
    const s = bestS;
    const u = s * L;
    const shape = this.shape;
    const w = shape.halfWidth(s) * L;
    this.hitS = s;
    this.hitV = a * bestSign;
    this.hitInside = 0;
    this.hitNear = near;

    const head = this.shape.head;
    if (head && u < L * (head.sweep + head.depth + head.notch)) {
      // Cephalofoil: a wide wing across the snout, its tips swept back toward the eyes,
      // and on a great hammerhead a shallow notch in the middle of the front edge.
      const span = L * head.span;
      const r = a / span;
      const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14);
      // Full depth almost to the tips, so the wing reads as a solid bar rather than a thin line.
      const depth = L * head.depth * (1 - 0.2 * r * r * r * r);
      if (r <= 1 && u >= front && u <= front + depth) {
        this.hitFlag = r > 0.84 ? FLAG_EYE : FLAG_BODY;
        this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0);
        return true;
      }
    }

    if (a <= w) {
      const across = a / (w || 1);
      // Rounded back lit from the top-left; flanks fall off into shadow.
      const facing = (bestNx * -0.6 + bestNy * -0.8) * across;
      let shade = 0.58 - across * across * 0.42 + facing * 0.26;
      let flag = FLAG_BODY;
      if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) {
        // First dorsal fin, catching the light.
        flag = FLAG_RIDGE;
        shade = 1;
      } else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && across < 0.4) {
        shade = Math.max(shade, 0.82);
      } else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
        flag = FLAG_EYE;
        shade = 0;
      } else if (s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
        // Five gill slits.
        if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0) shade *= 0.45;
      } else if (s < 0.05) {
        // Pale snout tip.
        shade = Math.max(shade, 0.7);
      } else if (shape === SHAPES.zebra && s > 0.08 && s < 0.55 && (across < 0.1 || Math.abs(across - 0.6) < 0.08)) {
        // Zebra sharks carry pale ridges down the back.
        shade = Math.max(shade, 0.8);
      } else if (this.marked(s, a * bestSign, L, across)) {
        flag = FLAG_MARK;
      }
      this.hitFlag = flag;
      this.hitShade = shade;
      this.hitInside = w - a;
      return true;
    }

    const tip = bestSign > 0 ? this.finTipRight : this.finTipLeft;
    const [p0, p1, p2] = shape.pectoral;
    if (
      inTriangle(u, a, L * p0, 0, L * p1, 0, L * p2, tip) &&
      // Falcate (sickle) fins get a concave trailing edge.
      !(shape.falcate && inTriangle(u, a, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))
    ) {
      this.hitFlag = this.marked(s, a * bestSign, L, 0) ? FLAG_MARK : FLAG_FIN;
      this.hitShade = 0.38 + 0.22 * (1 - clamp(a / tip, 0, 1));
      return true;
    }
    const [v0, v1, v2, vr] = shape.pelvic;
    if (
      inTriangle(u, a, L * v0, 0, L * v1, 0, L * v2, L * vr) ||
      // Forked caudal fin.
      (shape.caudal > 0 && inTriangle(u, a, L * 0.86, 0, L * 0.95, 0, L, L * shape.caudal))
    ) {
      this.hitFlag = FLAG_FIN;
      this.hitShade = 0.36;
      return true;
    }
    return false;
  }

  /** How far from the spine the part of the shark between body points `a` and `b` (0 snout, 1
   *  tail) reaches: its body's half-width, and past it the head or a fin where one is, as a share
   *  of its length. A fin is a triangle whose leading edge rises from its root to its tip, so it
   *  reaches far only near the tip. The half-width is taken at the ends and the middle: within one
   *  segment it changes by less than the margin its caller adds. */
  private segmentReach(a: number, b: number, L: number) {
    const sh = this.shape;
    // A fin from `root` to `tip` along the body, `reach` out at its tip: how far out it is by `b`.
    const fin = (root: number, tip: number, reach: number) => (b > root && a < tip ? reach * Math.min(1, (b - root) / (tip - root)) : 0);
    let r = Math.max(sh.halfWidth(a), sh.halfWidth((a + b) / 2), sh.halfWidth(b));
    const head = sh.head;
    if (head && a < head.sweep + head.depth + head.notch) r = Math.max(r, head.span);
    r = Math.max(r, fin(sh.pectoral[0], sh.pectoral[2], Math.max(this.finTipLeft, this.finTipRight) / L), fin(sh.pelvic[0], sh.pelvic[2], sh.pelvic[3]));
    if (sh.caudal > 0) r = Math.max(r, fin(0.86, 1, sh.caudal));
    return r;
  }

  /** Whether a body point (s along, v across) falls on a dark marking. */
  private marked(s: number, v: number, L: number, across: number) {
    if (this.shape === SHAPES.tiger) {
      // Wavy vertical bars over the back half, fading out toward the head.
      if (s < 0.2 || s > 0.9 || across > 0.85) return false;
      const wobble = 0.35 * Math.sin((v / L) * 25 + s * 5);
      const bar = Math.sin(s * Math.PI * 2 * 9 + wobble);
      return bar > 0.65 - 0.5 * smoothstep(0.2, 0.42, s) + 0.4 * smoothstep(0.8, 0.9, s);
    }
    if (this.shape === SHAPES.zebra) {
      // Leopard spots on a jittered grid, so they ride along with the skin.
      if (s < 0.07) return false;
      const gu = (s * L) / (L * 0.06);
      const gv = v / (L * 0.045);
      const cu = Math.floor(gu);
      const cv = Math.floor(gv);
      const jx = hash3(cu, cv, this.sharkId) * 0.5 + 0.25;
      const jy = hash3(cu, cv, this.sharkId + 11) * 0.5 + 0.25;
      return (gu - cu - jx) ** 2 + (gv - cv - jy) ** 2 < 0.08;
    }
    return false;
  }

  /**
   * Build a smooth, undulating render spine from the sim spine, then
   * supersample every cell in the shark's bounding box against the shape.
   * Fully covered cells become solid skin; partial cells become edge glyphs.
   */
  private rasterizeSharks(sharks: Shark[], t: number) {
    const { sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, cover, spine, arc, cw, ch, cols, rows } = this;
    sharkFlag.fill(0);

    for (const sh of sharks) {
      const L = sh.length;
      const N = SHARK_NODES;
      const n = sh.nodes;
      const swim = clamp(sh.speed / 60, 0.4, 1.4);
      this.shape = SHAPES[sh.kind as SharkKind];
      this.sharkId = sh.id;

      // Travelling body wave, growing toward the tail.
      for (let k = 0; k < N; k++) {
        const s = k / (N - 1);
        const a = Math.max(0, k - 1);
        const b = Math.min(N - 1, k + 1);
        let tx = n[a * 2]! - n[b * 2]!;
        let ty = n[a * 2 + 1]! - n[b * 2 + 1]!;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const amp = L * 0.05 * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim;
        const off = amp * Math.sin(sh.phase - s * 5.2);
        spine[k * 2] = n[k * 2]! - ty * off;
        spine[k * 2 + 1] = n[k * 2 + 1]! + tx * off;
      }
      arc[0] = 0;
      for (let k = 1; k < N; k++) {
        arc[k] =
          arc[k - 1]! +
          Math.hypot(spine[k * 2]! - spine[(k - 1) * 2]!, spine[k * 2 + 1]! - spine[(k - 1) * 2 + 1]!);
      }
      this.arcTotal = arc[N - 1]! || 1;
      for (let k = 0; k < N - 1; k++) {
        const dx = spine[(k + 1) * 2]! - spine[k * 2]!;
        const dy = spine[(k + 1) * 2 + 1]! - spine[k * 2 + 1]!;
        this.segDx[k] = dx;
        this.segDy[k] = dy;
        this.segLen2[k] = dx * dx + dy * dy || 1;
      }

      // Bank into turns: the inside fin foreshortens, the outside one spreads.
      const bank = clamp(sh.turn * 0.45, -0.35, 0.35);
      const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5);
      const reachFin = this.shape.pectoral[3];
      this.finTipRight = L * reachFin * flex * (1 - bank);
      this.finTipLeft = L * reachFin * flex * (1 + bank);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < N; k++) {
        minX = Math.min(minX, spine[k * 2]!);
        maxX = Math.max(maxX, spine[k * 2]!);
        minY = Math.min(minY, spine[k * 2 + 1]!);
        maxY = Math.max(maxY, spine[k * 2 + 1]!);
      }
      const reach = L * 0.36;
      const c0 = Math.max(0, Math.floor((minX - reach) / cw));
      const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
      const r0 = Math.max(0, Math.floor((minY - reach) / ch));
      const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
      if (c0 > c1 || r0 > r1) continue;

      // A cell whose centre is this far inside the body is covered whole: no sub-sample can miss.
      const halfCell = Math.hypot(cw, ch) / 2;
      // Each segment's own reach, and half a cell more: a sample is on the shark only within its
      // part's reach of the segment its nearest spine point is on, and a cell's samples are within
      // half a cell of its centre. So a row is searched only as far as some segment reaches, and a
      // cell whose centre is out of every segment's reach is empty (checked against sampling every
      // cell). The body is narrow along most of its length; only the head and fin tips reach far.
      const segReach = this.segReach;
      for (let k = 0; k < N - 1; k++) segReach[k] = this.segmentReach(arc[k]! / this.arcTotal, arc[k + 1]! / this.arcTotal, L) * L + L * 0.02 + halfCell;

      for (let r = r0; r <= r1; r++) {
        // Only the cells of this row the shark can reach: a diagonal shark leaves most of its box
        // empty, and an empty cell would still be tested against every segment of the spine.
        const yc = r * ch + ch / 2;
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < N - 1; k++) {
          const ya = spine[k * 2 + 1]!;
          const yb = spine[k * 2 + 3]!;
          const rk = segReach[k]!;
          if (yc < Math.min(ya, yb) - rk || yc > Math.max(ya, yb) + rk) continue;
          lo = Math.min(lo, spine[k * 2]! - rk, spine[k * 2 + 2]! - rk);
          hi = Math.max(hi, spine[k * 2]! + rk, spine[k * 2 + 2]! + rk);
        }
        if (lo > hi) continue;
        const cLo = Math.max(c0, Math.floor(lo / cw));
        const cHi = Math.min(c1, Math.floor(hi / cw));
        for (let c = cLo; c <= cHi; c++) {
          if (cover[r * cols + c] && !this.seeThrough) continue;
          const x = c * cw;
          const y = r * ch;
          const centerHit = this.sampleShark(x + cw / 2, y + ch / 2, L);
          if (!centerHit && !this.hitNear) continue;
          const flag = this.hitFlag;
          const shade = this.hitShade;
          const s = this.hitS;
          const v = this.hitV;

          let hits = centerHit ? 1 : 0;
          if (centerHit && this.hitInside > halfCell) hits = 5;
          else {
            for (let k = 0; k < SUBSAMPLES.length; k += 2) {
              if (this.sampleShark(x + SUBSAMPLES[k]! * cw, y + SUBSAMPLES[k + 1]! * ch, L)) hits++;
            }
          }
          if (hits === 0) continue;
          const coverage = hits / 5;

          const i = r * cols + c;
          // Body-anchored key so each glyph rides along with the skin.
          const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0;
          sharkKey[i] = key;
          sharkDepth[i] = sh.depth;
          sharkKind[i] = KIND_INDEX[sh.kind as SharkKind];

          if (centerHit && coverage >= 0.6) {
            sharkFlag[i] = flag;
            const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06;
            sharkShade[i] = clamp(shade + flicker, 0, 1);
          } else {
            sharkFlag[i] = FLAG_EDGE;
            sharkShade[i] = coverage;
          }
        }
      }
    }
  }

  private drawSharks(t: number) {
    const { ctx, cols, rows, cw, ch, light, sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, cover } = this;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      const flag = sharkFlag[i]!;
      if (!flag) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cw;
      const y = row * ch;
      const key = sharkKey[i]!;
      const shade = sharkShade[i]!;
      const dim = 0.7 + 0.3 * sharkDepth[i]!;
      const kind = sharkKind[i]!;
      const ramp = this.kindRamps[kind]!;

      // Glints re-roll on a staggered clock so the hide shimmers.
      const tick = Math.floor(t * 2.4 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);

      if (flag === FLAG_EDGE) {
        // Soft, anti-aliased silhouette: on dark water a light glyph alone, on light water a faint
        // block under it too, so the edge fades into the page.
        const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        const glyph = set[(key >>> 8) % set.length]!;
        if (cover[i]) {
          this.softCell(i, light ? (INK.edge + INK.edgeSpan * shade) * dim : (((70 + shade * 80) * dim) / 255) * shade, kind);
          continue;
        }
        if (light) {
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
      const lit = (level * dim) / 255;
      let block: number;
      let ink: number;
      if (light) {
        // Ink on paper: the more of the shark, the darker its block, and its character darker still.
        if (flag === FLAG_EYE) { block = lit; ink = 0.62; }
        else if (flag === FLAG_MARK) { block = lit; ink = 0.27; }
        else {
          block = INK.base + INK.span * lit;
          ink = roll < 0.04 ? Math.max(0, block - INK.glint) : block + INK.glyph;
        }
      } else {
        block = this.colour && flag !== FLAG_EYE && flag !== FLAG_MARK ? LIFT.base + LIFT.span * lit : lit;
        if (flag === FLAG_EYE) ink = 0.62;
        else if (flag === FLAG_MARK) ink = 0.27;
        else if (roll < 0.05) ink = 1;
        else ink = shade > 0.55 ? 0.05 : 0.1;
      }
      if (cover[i]) {
        this.softCell(i, block, kind);
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
    const { fishStamp, fishBuckets, sharkFlag } = this;
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
    const { ctx, cols, rows, cw, ch, energy, sharkFlag, fishStamp, frameId } = this;
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
