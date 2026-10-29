/**
 * Koi Pond's koi, seen from above (live/spine.ts draws them): a rounded head, a full body that
 * narrows to the tail, round paddle fins and a fan of a tail. Each variety is one program's agents,
 * known by its pattern: a marking of its own colour rides the skin, as a shark's markings do.
 * Markings: 1 the variety's first colour (red mostly), 2 its second (black or white).
 */
import { hash3, smoothstep } from "../math";
import type { SpineShape } from "../spine";

export type KoiKind = "kohaku" | "sanke" | "showa" | "tancho" | "ogon" | "platinum" | "asagi" | "chagoi";

/** The varieties, in the order an agent's variant picks them. */
export const KOI_KINDS: KoiKind[] = ["kohaku", "showa", "ogon", "asagi", "sanke", "tancho", "platinum", "chagoi"];

function halfWidth(s: number) {
  // A blunt, round head.
  if (s < 0.12) return 0.12 * Math.pow(Math.sin(((s / 0.12) * Math.PI) / 2), 0.5);
  if (s < 0.34) return 0.12 + 0.03 * smoothstep(0.12, 0.34, s);
  if (s < 0.8) return 0.026 + 0.124 * Math.pow(1 - (s - 0.34) / 0.46, 1.3);
  const k = (s - 0.8) / 0.2;
  return 0.026 * (1 - k) + 0.008 * Math.sin(k * Math.PI);
}

/** Smooth noise over the skin, 0 to 1: the same body point gives the same value. */
function noise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothstep(0, 1, x - xi);
  const v = smoothstep(0, 1, y - yi);
  const a = hash3(xi, yi, seed);
  const b = hash3(xi + 1, yi, seed);
  const c = hash3(xi, yi + 1, seed);
  const d = hash3(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Whether a point is on the edge of a scale: a net over the back. */
function scaleEdge(s: number, vn: number) {
  const gu = s / 0.034;
  const row = Math.floor(gu);
  const gv = vn / 0.026 + (row % 2) * 0.5;
  const fu = gu - row;
  const fv = gv - Math.floor(gv);
  return fu < 0.28 || Math.abs(fv - 0.5) > 0.36;
}

/** Red patches over the back, from the head toward the tail, none on the fins: a kohaku's. */
function patches(s: number, vn: number, id: number, fin: boolean) {
  if (fin || s < 0.03 || s > 0.8) return false;
  return noise(s * 7.5, vn * 9 + 3, id) > 0.5 - 0.12 * smoothstep(0.05, 0.25, 0.3 - Math.abs(s - 0.3));
}

const body: Omit<SpineShape, "mark"> = {
  halfWidth,
  pectoral: [0.17, 0.27, 0.27, 0.22],
  falcate: false,
  pelvic: [0.47, 0.53, 0.56, 0.1],
  caudal: 0.2,
  tail: [0.78, 1],
  dorsal: [0.3, 0.6],
  secondDorsal: [0, 0],
  eye: [0.05, 0.085],
  gills: null,
  sway: 0.07,
};

/** A butterfly koi: long, trailing fins and tail. */
const butterfly: Omit<SpineShape, "mark"> = {
  ...body,
  pectoral: [0.17, 0.28, 0.34, 0.29],
  pelvic: [0.47, 0.55, 0.6, 0.14],
  caudal: 0.23,
  tail: [0.72, 1],
  sway: 0.08,
};

export const KOI_SHAPES: Record<KoiKind, SpineShape> = {
  kohaku: { ...body, mark: (s, v, L, _a, id, fin) => (patches(s, v / L, id, fin) ? 1 : 0) },
  // Kohaku's red, and small black spots over the back, none on the head.
  sanke: {
    ...body,
    mark: (s, v, L, _a, id, fin) => {
      if (!fin && s > 0.16 && s < 0.82 && noise(s * 15, (v / L) * 17, id + 7) > 0.74) return 2;
      return patches(s, v / L, id, fin) ? 1 : 0;
    },
  },
  // Black, with red and white over it; black at the roots of its fins.
  showa: {
    ...body,
    mark: (s, v, L, _a, id, fin) => {
      if (fin) return Math.abs(v) / L < 0.09 ? 0 : 2;
      if (noise(s * 7, (v / L) * 8 + 5, id + 3) > 0.56) return 1;
      return noise(s * 6, (v / L) * 7 + 9, id + 13) > 0.5 ? 2 : 0;
    },
  },
  // White, one round red spot on the head.
  tancho: {
    ...body,
    mark: (s, v, L, _a, _id, fin) => (!fin && ((s - 0.085) / 0.05) ** 2 + (v / L / 0.05) ** 2 < 1 ? 1 : 0),
  },
  ogon: { ...butterfly },
  platinum: { ...butterfly },
  // A blue net over the back, red-orange along the flanks, the cheeks and the fins.
  asagi: {
    ...body,
    mark: (s, v, L, across, _id, fin) => {
      if (fin || across > 0.72 || (s < 0.12 && across > 0.45)) return 1;
      return s > 0.12 && s < 0.82 && scaleEdge(s, v / L) ? 2 : 0;
    },
  },
  // Copper, its scales netted darker.
  chagoi: {
    ...body,
    mark: (s, v, L, _a, _id, fin) => (!fin && s > 0.1 && s < 0.82 && scaleEdge(s, v / L) ? 1 : 0),
  },
};

/** In the theme's colours a koi has no cast: its pattern is all it shows. */
export const KOI_TINTS: Record<KoiKind, number[]> = Object.fromEntries(KOI_KINDS.map((k) => [k, [1, 1, 1]])) as Record<KoiKind, number[]>;

/** In the theme's colours, a pattern's colours as shares of the skin's light: red mid, black
 *  dark, white full. */
export const KOI_MONO_MARKS: Record<KoiKind, number[]> = {
  kohaku: [0.5],
  sanke: [0.5, 0.18],
  showa: [0.5, 1],
  tancho: [0.5],
  ogon: [],
  platinum: [],
  asagi: [0.55, 0.62],
  chagoi: [0.7],
};

/** And the skin itself: a showa is black under its pattern. */
export const KOI_MONO_SKIN: Partial<Record<KoiKind, number>> = { showa: 0.22, chagoi: 0.75, asagi: 0.8 };
