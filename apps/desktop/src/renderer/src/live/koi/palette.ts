/**
 * Koi Pond in its own colours: green water under leaves, lily pads with their veins and now and
 * then a flower, rings where something touches the surface, and koi in their varieties' colours.
 * On a light theme a sunny pond, the koi bright on it as they are on the dark one. The water is
 * kept dark (or light) enough for the frosted panels' text over it (live-palette.test.ts).
 */
import type { Oklch } from "../colour";
import type { SwimPalette } from "../swim";
import type { KoiKind } from "./shapes";

/** Fish by species: fry, medaka. */
export interface KoiPalette extends SwimPalette {
  kinds: Record<KoiKind, Oklch>;
  marks: Partial<Record<KoiKind, Oklch[]>>;
  pond: {
    /** A pad's block, its characters, the veins from its middle and its rim. */
    pad: Oklch;
    padGlyph: Oklch;
    vein: Oklch;
    rim: Oklch;
    /** A flower's petals and their characters, and its middle. */
    petal: Oklch;
    petalGlyph: Oklch;
    heart: Oklch;
    /** A ring on the water. */
    ripple: Oklch;
    /** Pebbles on the bottom, under it all. */
    pebble: Oklch;
    /** A koi's shadow on the bottom, and how dark. */
    shade: Oklch;
    shadeAlpha: number;
  };
}

const RED: Oklch = [0.64, 0.21, 33];
const WHITE: Oklch = [0.95, 0.012, 90];

const dark: KoiPalette = {
  water: [[0.33, 0.058, 168], [0.28, 0.054, 178], [0.22, 0.045, 190]],
  glow: { colour: [0.62, 0.09, 140], alpha: 0.12 },
  grid: { colour: [1, 0, 0], alpha: 0.035 },
  shafts: { colour: [0.9, 0.07, 115], alpha: 0.055, add: true },
  shadow: [0.3, 0.04, 175],
  lift: { base: 0.42, span: 0.66 },
  kinds: {
    kohaku: WHITE, sanke: WHITE, tancho: WHITE,
    showa: [0.42, 0.012, 260],
    ogon: [0.86, 0.15, 86],
    platinum: [0.94, 0.02, 230],
    asagi: [0.7, 0.05, 238],
    chagoi: [0.68, 0.1, 58],
  },
  marks: {
    kohaku: [RED],
    sanke: [RED, [0.33, 0.012, 260]],
    showa: [RED, WHITE],
    tancho: [[0.62, 0.22, 30]],
    asagi: [[0.68, 0.17, 42], [0.55, 0.055, 240]],
    chagoi: [[0.52, 0.09, 50]],
  },
  fish: [[0.8, 0.04, 120], [0.84, 0.1, 80]],
  wake: [0.86, 0.05, 160],
  flash: [0.97, 0.06, 95],
  pond: {
    pad: [0.48, 0.11, 142],
    padGlyph: [0.36, 0.09, 146],
    vein: [0.66, 0.12, 128],
    rim: [0.6, 0.13, 132],
    petal: [0.76, 0.12, 352],
    petalGlyph: [0.94, 0.05, 350],
    heart: [0.88, 0.15, 95],
    ripple: [0.86, 0.04, 168],
    pebble: [0.4, 0.025, 90],
    shade: [0.13, 0.04, 190],
    shadeAlpha: 0.35,
  },
};

const light: KoiPalette = {
  water: [[0.9, 0.045, 165], [0.865, 0.052, 172], [0.83, 0.058, 182]],
  glow: { colour: [1, 0, 0], alpha: 0.35 },
  grid: { colour: [0.35, 0.06, 170], alpha: 0.05 },
  shafts: { colour: [1, 0, 0], alpha: 0.3, add: false },
  shadow: [0.7, 0.045, 175],
  bright: true,
  lift: { base: 0.42, span: 0.66 },
  kinds: {
    // Cream, not white: white on the pale water went missing.
    kohaku: [0.975, 0.03, 88], sanke: [0.975, 0.03, 88], tancho: [0.975, 0.03, 88],
    showa: [0.3, 0.012, 260],
    ogon: [0.82, 0.16, 84],
    platinum: [0.97, 0.015, 230],
    asagi: [0.62, 0.06, 238],
    chagoi: [0.62, 0.11, 56],
  },
  marks: {
    kohaku: [[0.6, 0.21, 32]],
    sanke: [[0.6, 0.21, 32], [0.28, 0.012, 260]],
    showa: [[0.6, 0.21, 32], [0.975, 0.03, 88]],
    tancho: [[0.58, 0.22, 30]],
    asagi: [[0.64, 0.18, 42], [0.48, 0.06, 240]],
    chagoi: [[0.46, 0.09, 50]],
  },
  fish: [[0.55, 0.05, 120], [0.62, 0.12, 75]],
  wake: [0.55, 0.06, 170],
  flash: [0.6, 0.17, 45],
  pond: {
    pad: [0.64, 0.13, 138],
    padGlyph: [0.46, 0.12, 142],
    vein: [0.8, 0.11, 125],
    rim: [0.72, 0.14, 128],
    petal: [0.8, 0.12, 352],
    petalGlyph: [0.58, 0.18, 355],
    heart: [0.8, 0.16, 92],
    ripple: [0.6, 0.06, 175],
    pebble: [0.78, 0.03, 90],
    shade: [0.5, 0.05, 182],
    shadeAlpha: 0.42,
  },
};

export const KOI_PALETTE = { dark, light };
