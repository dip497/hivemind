/**
 * Shoal in its own colours: a reef's water, from teal at the surface to deep blue at the bottom,
 * coral and weed on the bed, and fish and sharks in their own hues. On a light theme a sunlit
 * lagoon, its creatures drawn darker than the water as ink on paper, as the plain Shoal is.
 * The water is kept dark (or light) enough for the frosted panels' text over it (palette.test.ts).
 */
import type { Oklch } from "../colour";
import type { SwimPalette } from "../swim";
import type { SharkKind } from "./shapes";

/** Fish by species (species.ts): sardine, anchovy, silverside, mackerel, goby. */
export interface ShoalPalette extends SwimPalette {
  kinds: Record<SharkKind, Oklch>;
  /** Each part of the bed in its own colour: its characters in it, on a block of it half faded
   *  into the deep water (seabed.ts). Branching corals and sponges take the three corals. */
  seabed: {
    sand: Oklch;
    rock: Oklch;
    corals: Oklch[];
    fan: Oklch;
    brain: Oklch;
    weeds: Oklch[];
  };
}

const dark: ShoalPalette = {
  water: [[0.31, 0.068, 204], [0.26, 0.062, 224], [0.19, 0.052, 246]],
  glow: { colour: [0.62, 0.08, 195], alpha: 0.16 },
  grid: { colour: [1, 0, 0], alpha: 0.04 },
  shafts: { colour: [0.9, 0.05, 190], alpha: 0.075, add: true },
  shadow: [0.3, 0.05, 232],
  kinds: {
    classic: [0.86, 0.02, 232],
    hammerhead: [0.8, 0.035, 105],
    tiger: [0.81, 0.045, 75],
    mako: [0.75, 0.07, 256],
    thresher: [0.77, 0.05, 320],
    zebra: [0.86, 0.06, 86],
    greathammer: [0.79, 0.03, 246],
    nurse: [0.75, 0.065, 60],
  },
  fish: [[0.84, 0.045, 230], [0.86, 0.13, 95], [0.82, 0.09, 205], [0.74, 0.15, 48], [0.7, 0.17, 25]],
  wake: [0.86, 0.06, 200],
  flash: [0.97, 0.06, 95],
  seabed: {
    sand: [0.64, 0.055, 80],
    rock: [0.46, 0.025, 60],
    corals: [[0.74, 0.12, 115], [0.68, 0.14, 48], [0.68, 0.13, 355]],
    fan: [0.64, 0.13, 305],
    brain: [0.66, 0.11, 330],
    weeds: [[0.6, 0.12, 150], [0.66, 0.11, 128], [0.55, 0.08, 172]],
  },
};

const light: ShoalPalette = {
  water: [[0.965, 0.03, 196], [0.93, 0.042, 206], [0.885, 0.05, 222]],
  glow: { colour: [1, 0, 0], alpha: 0.45 },
  grid: { colour: [0.4, 0.06, 222], alpha: 0.05 },
  shafts: { colour: [1, 0, 0], alpha: 0.4, add: false },
  shadow: [0.95, 0.035, 205],
  kinds: {
    classic: [0.36, 0.035, 240],
    hammerhead: [0.4, 0.04, 105],
    tiger: [0.42, 0.05, 65],
    mako: [0.35, 0.08, 262],
    thresher: [0.38, 0.06, 320],
    zebra: [0.46, 0.06, 80],
    greathammer: [0.36, 0.035, 246],
    nurse: [0.43, 0.06, 55],
  },
  fish: [[0.5, 0.08, 242], [0.66, 0.14, 82], [0.55, 0.1, 205], [0.62, 0.17, 45], [0.58, 0.19, 25]],
  wake: [0.55, 0.07, 222],
  flash: [0.6, 0.17, 45],
  seabed: {
    sand: [0.72, 0.06, 80],
    rock: [0.58, 0.03, 60],
    corals: [[0.6, 0.13, 115], [0.62, 0.15, 45], [0.6, 0.14, 355]],
    fan: [0.54, 0.13, 305],
    brain: [0.58, 0.12, 330],
    weeds: [[0.54, 0.12, 150], [0.6, 0.12, 128], [0.5, 0.08, 172]],
  },
};

export const SHOAL_PALETTE = { dark, light };
