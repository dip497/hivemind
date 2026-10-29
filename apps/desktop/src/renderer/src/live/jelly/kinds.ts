/**
 * Jellyfish's jellies, seen from the side as they swim up the water: each kind's bell, its rim,
 * its tentacles and oral arms, its beat, and the pattern in its bell. Each is one program's agents.
 */
export type JellyKind = "moon" | "pelagia" | "nettle" | "crystal" | "lionsmane" | "friedegg" | "box" | "comb";

/** The kinds, in the order an agent's variant picks them. */
export const JELLY_KINDS: JellyKind[] = ["moon", "pelagia", "nettle", "crystal", "lionsmane", "friedegg", "box", "comb"];

export interface JellyShape {
  /** The bell's half-width and its height, as shares of the scene's unit. */
  w: number;
  h: number;
  /** The dome's profile: 2 round, more flat-topped and straight-sided (a box), less pointed. */
  dome: number;
  /** How far its rim hangs below the dome, as a share of its height. */
  skirt: number;
  /** Tentacles from the rim: how many, and how long against the unit. */
  tentacles: number;
  reach: number;
  /** Oral arms from the middle, frillier: how many, how long. */
  arms: number;
  armReach: number;
  /** Beats a second when it cruises. */
  rate: number;
  /** The pattern in the bell at `u` across (-1 to 1) and `v` down it (0 the top, 1 the rim), at
   *  time `t`: 0 the bell's own colour, 1 its marking, 2 its second. */
  pattern(u: number, v: number, t: number): number;
}

export const JELLY_SHAPES: Record<JellyKind, JellyShape> = {
  // Wide and flat, four horseshoe gonads showing through it, a fringe of short tentacles.
  moon: {
    w: 0.56, h: 0.42, dome: 2.2, skirt: 0.12, tentacles: 9, reach: 0.45, arms: 2, armReach: 0.55, rate: 0.5,
    pattern: (u, v) => {
      const ring = Math.abs(Math.hypot((Math.abs(u) - 0.42) / 0.6, (v - 0.55) / 0.5) - 0.5);
      return v > 0.25 && v < 0.85 && ring < 0.14 ? 1 : 0;
    },
  },
  // Taller, purple, striped from its top to its rim, long thin tentacles and frilled arms.
  pelagia: {
    w: 0.42, h: 0.56, dome: 2, skirt: 0.14, tentacles: 6, reach: 1.3, arms: 4, armReach: 0.9, rate: 0.7,
    pattern: (u, v) => (v > 0.2 && Math.abs(Math.sin(u * 7.5)) < 0.3 ? 1 : 0),
  },
  // Gold, its stripes dark, the longest tentacles of them all and long ribbons of arms.
  nettle: {
    w: 0.46, h: 0.48, dome: 2, skirt: 0.1, tentacles: 7, reach: 1.9, arms: 4, armReach: 1.2, rate: 0.6,
    pattern: (u, v) => (v > 0.3 && Math.abs(Math.sin(u * 6 + 0.4)) < 0.24 ? 1 : v < 0.22 ? 2 : 0),
  },
  // Nearly clear, its canals fine lines, a ring of lights round its rim, short fine tentacles.
  crystal: {
    w: 0.52, h: 0.38, dome: 2.4, skirt: 0.08, tentacles: 12, reach: 0.55, arms: 1, armReach: 0.3, rate: 0.55,
    pattern: (u, v) => (v > 0.82 ? (Math.floor((u + 1) * 7) % 2 ? 2 : 0) : v > 0.25 && Math.abs(Math.sin(u * 11)) < 0.14 ? 1 : 0),
  },
  // Big and red, its rim lobed, a mane of tentacles.
  lionsmane: {
    w: 0.6, h: 0.48, dome: 2, skirt: 0.16, tentacles: 14, reach: 1.4, arms: 3, armReach: 0.8, rate: 0.4,
    pattern: (u, v) => (v > 0.45 && Math.abs(Math.sin(u * 9)) < 0.35 ? 1 : 0),
  },
  // Flat and white, a yolk in its middle, short arms with purple tips.
  friedegg: {
    w: 0.56, h: 0.34, dome: 2.6, skirt: 0.08, tentacles: 6, reach: 0.4, arms: 5, armReach: 0.55, rate: 0.45,
    pattern: (u, v) => (Math.hypot(u / 0.55, (v - 0.35) / 0.55) < 1 ? 1 : 0),
  },
  // A box, pale blue, a long tentacle from each corner.
  box: {
    w: 0.34, h: 0.56, dome: 6, skirt: 0.06, tentacles: 4, reach: 1.5, arms: 0, armReach: 0, rate: 1,
    pattern: (u, v) => (Math.abs(Math.abs(u) - 0.55) < 0.1 && v > 0.15 ? 1 : 0),
  },
  // A comb jelly: a lemon of a body, no bell to beat, its eight rows of combs flashing colours
  // that run down them.
  comb: {
    w: 0.28, h: 0.74, dome: 1.6, skirt: 0, tentacles: 0, reach: 0, arms: 0, armReach: 0, rate: 0.35,
    pattern: (u, v, t) => {
      const row = Math.abs(Math.sin(u * 6.3));
      if (row > 0.2) return 0;
      return Math.sin(v * 9 - t * 6 + u * 2) > 0 ? 1 : 2;
    },
  },
};
