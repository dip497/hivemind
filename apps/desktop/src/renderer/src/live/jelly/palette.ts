/**
 * Jellyfish in its own colours: the deep sea, blue to near black, light coming down from far
 * above, marine snow, and jellies in their own colours, each glowing faintly. On a light theme a
 * pale sea, the jellies deeper-coloured on it. The water is kept dark (or light) enough for the
 * frosted panels' text over it (live-palette.test.ts).
 */
import type { WaterLook } from "../backdrop";
import type { Oklch } from "../colour";
import type { JellyKind } from "./kinds";

export interface JellyColours {
  bell: Oklch;
  /** Its pattern's colours: its marking and its second. */
  mark: Oklch;
  mark2: Oklch;
  tentacle: Oklch;
}

export interface JellyPalette extends WaterLook {
  kinds: Record<JellyKind, JellyColours>;
  snow: Oklch;
  /** How bright a jelly's own faint glow is, without a flash. */
  shine: number;
}

const dark: JellyPalette = {
  water: [[0.27, 0.07, 255], [0.2, 0.06, 262], [0.14, 0.045, 268]],
  glow: { colour: [0.5, 0.1, 240], alpha: 0.16 },
  grid: { colour: [1, 0, 0], alpha: 0.03 },
  shafts: { colour: [0.85, 0.06, 230], alpha: 0.065, add: true },
  kinds: {
    moon: { bell: [0.84, 0.04, 240], mark: [0.74, 0.12, 330], mark2: [0.74, 0.12, 330], tentacle: [0.8, 0.04, 240] },
    pelagia: { bell: [0.62, 0.16, 310], mark: [0.44, 0.14, 305], mark2: [0.72, 0.14, 320], tentacle: [0.68, 0.13, 315] },
    nettle: { bell: [0.78, 0.14, 65], mark: [0.54, 0.12, 45], mark2: [0.86, 0.12, 80], tentacle: [0.74, 0.13, 50] },
    crystal: { bell: [0.86, 0.03, 200], mark: [0.72, 0.06, 200], mark2: [0.86, 0.16, 165], tentacle: [0.82, 0.03, 200] },
    lionsmane: { bell: [0.64, 0.17, 30], mark: [0.5, 0.15, 25], mark2: [0.74, 0.14, 45], tentacle: [0.7, 0.14, 40] },
    friedegg: { bell: [0.92, 0.03, 90], mark: [0.85, 0.16, 85], mark2: [0.62, 0.15, 310], tentacle: [0.86, 0.05, 90] },
    box: { bell: [0.82, 0.07, 215], mark: [0.7, 0.1, 210], mark2: [0.88, 0.05, 215], tentacle: [0.8, 0.05, 215] },
    comb: { bell: [0.8, 0.03, 250], mark: [0.74, 0.17, 320], mark2: [0.8, 0.15, 190], tentacle: [0.8, 0.03, 250] },
  },
  snow: [0.84, 0.03, 240],
  shine: 0.1,
};

const light: JellyPalette = {
  water: [[0.95, 0.025, 235], [0.915, 0.035, 240], [0.875, 0.045, 245]],
  glow: { colour: [1, 0, 0], alpha: 0.4 },
  grid: { colour: [0.35, 0.05, 240], alpha: 0.05 },
  shafts: { colour: [1, 0, 0], alpha: 0.35, add: false },
  kinds: {
    moon: { bell: [0.72, 0.06, 240], mark: [0.6, 0.14, 330], mark2: [0.6, 0.14, 330], tentacle: [0.64, 0.06, 240] },
    pelagia: { bell: [0.55, 0.16, 310], mark: [0.4, 0.15, 305], mark2: [0.62, 0.15, 320], tentacle: [0.56, 0.14, 315] },
    nettle: { bell: [0.68, 0.15, 60], mark: [0.48, 0.13, 45], mark2: [0.76, 0.14, 80], tentacle: [0.6, 0.14, 50] },
    crystal: { bell: [0.74, 0.05, 200], mark: [0.6, 0.07, 200], mark2: [0.66, 0.17, 165], tentacle: [0.66, 0.05, 200] },
    lionsmane: { bell: [0.56, 0.18, 30], mark: [0.44, 0.16, 25], mark2: [0.64, 0.16, 45], tentacle: [0.58, 0.15, 40] },
    friedegg: { bell: [0.8, 0.04, 90], mark: [0.74, 0.17, 85], mark2: [0.5, 0.16, 310], tentacle: [0.68, 0.06, 90] },
    box: { bell: [0.7, 0.08, 215], mark: [0.56, 0.1, 210], mark2: [0.78, 0.06, 215], tentacle: [0.64, 0.06, 215] },
    comb: { bell: [0.72, 0.04, 250], mark: [0.6, 0.18, 320], mark2: [0.64, 0.15, 190], tentacle: [0.7, 0.04, 250] },
  },
  snow: [0.6, 0.04, 240],
  shine: 0.12,
};

export const JELLY_PALETTE = { dark, light };
