/**
 * Koi Pond's surface: lily pads that drift and turn slowly on it, some with a flower, and rings
 * where something touches it. The pads are laid out once per window from a fixed seed; what a cell
 * of a pad is (`padCell`) is worked out from the pad's own shape, so a pad looks the same wherever
 * it has drifted to.
 */
import { angleDiff, hash3, rand, TAU } from "../math";
import type { Mood } from "../scene";

export interface Pad {
  x: number;
  y: number;
  /** Radius, in px. */
  r: number;
  /** Which way its notch points, and how wide the notch is either side. */
  turn: number;
  notch: number;
  /** How fast it turns (rad/s) and drifts (px/s). */
  spin: number;
  vx: number;
  vy: number;
  /** Where its flower sits (an angle from the middle), or null for none. */
  flower: number | null;
  seed: number;
}

export interface Ripple {
  x: number;
  y: number;
  /** Seconds since it started. */
  age: number;
  /** 0 to 1: how far it spreads and how bright it starts. */
  strength: number;
}

/** What a cell of a pad is. */
export const PadPart = { None: 0, Leaf: 1, Rim: 2, Vein: 3, Petal: 4, Heart: 5 } as const;
export type PadPart = (typeof PadPart)[keyof typeof PadPart];

/** How long a ring lasts, and how fast it spreads. */
export const RIPPLE_LIFE = 2.4;
export const RIPPLE_SPEED = 64;
/** At most this many rings at once: the oldest goes first. */
const MAX_RIPPLES = 14;

/** A small seeded generator (mulberry32), apart from Math.random, which the World's run keeps. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The veins: this many, evenly round the pad from its notch. */
const VEINS = 6;

/** What the point (dx, dy) from a pad's middle is on it: a cell `cw` wide judges how near a vein
 *  or the rim it is. */
export function padCell(p: Pad, dx: number, dy: number, cw: number): PadPart {
  const d = Math.hypot(dx, dy);
  if (d > p.r) return PadPart.None;
  const a = Math.atan2(dy, dx);
  // The notch: a wedge cut from the rim to near the middle.
  if (d > cw * 1.2 && Math.abs(angleDiff(p.turn, a)) < p.notch) return PadPart.None;
  if (p.flower !== null) {
    const fx = Math.cos(p.flower) * p.r * 0.45;
    const fy = Math.sin(p.flower) * p.r * 0.45;
    const f = Math.hypot(dx - fx, (dy - fy) * 1.45);
    if (f < cw * 0.8) return PadPart.Heart;
    if (f < cw * 2.1) return PadPart.Petal;
  }
  if (d > p.r - cw * 0.85) return PadPart.Rim;
  // A vein: within half a cell of a line out from the middle.
  const step = TAU / VEINS;
  const off = Math.abs((((a - p.turn - step / 2) % step) + step) % step - step / 2);
  if (d > cw * 0.9 && off * d < cw * 0.5) return PadPart.Vein;
  return PadPart.Leaf;
}

/** What the surface reads of a koi: where its head is and what its agent is doing. */
export interface Surfacer {
  id: number;
  mood: Mood;
  leaving: boolean;
  nodes: Float32Array;
}

export class Pond {
  pads: Pad[] = [];
  ripples: Ripple[] = [];
  private width = 0;
  private height = 0;
  /** When each koi at the surface next mouths at it, and when something next drops on it. */
  private mouths = new Map<number, number>();
  private nextDrop = 0;

  /** Pads for a window: about one to a 300 px square, apart from each other. */
  build(W: number, H: number) {
    this.width = W;
    this.height = H;
    const rnd = prng(0x1f0 + Math.round(W) * 7 + Math.round(H));
    const n = Math.max(4, Math.min(18, Math.round((W * H) / 90000)));
    const unit = Math.min(W, H) / 900;
    this.pads = [];
    for (let tries = 0; this.pads.length < n && tries < n * 30; tries++) {
      const r = (28 + rnd() * 40) * Math.max(0.7, unit);
      const x = rnd() * W;
      const y = rnd() * H;
      if (this.pads.some((p) => Math.hypot(p.x - x, p.y - y) < (p.r + r) * 1.15)) continue;
      const k = this.pads.length;
      this.pads.push({
        x, y, r,
        turn: rnd() * TAU,
        notch: 0.22 + rnd() * 0.18,
        spin: (rnd() - 0.5) * 0.04,
        vx: (rnd() - 0.5) * 5,
        vy: (rnd() - 0.5) * 3,
        flower: k % 3 === 1 ? rnd() * TAU : null,
        seed: Math.floor(rnd() * 1e9),
      });
    }
    this.ripples = [];
  }

  /** `dt` seconds on: the pads drift and turn, a pad gone off one side comes back on the other,
   *  and the rings spread and fade. */
  step(dt: number) {
    const { width: W, height: H } = this;
    for (const p of this.pads) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.turn += p.spin * dt;
      if (p.x < -p.r) p.x += W + 2 * p.r;
      else if (p.x > W + p.r) p.x -= W + 2 * p.r;
      if (p.y < -p.r) p.y += H + 2 * p.r;
      else if (p.y > H + p.r) p.y -= H + 2 * p.r;
    }
    for (const r of this.ripples) r.age += dt;
    if (this.ripples.some((r) => r.age > RIPPLE_LIFE)) this.ripples = this.ripples.filter((r) => r.age <= RIPPLE_LIFE);
  }

  /** At time `t`: a koi whose agent needs you is up at the surface by its tile, mouthing at it, a
   *  ring every two seconds or so; and now and then something drops on the water somewhere. */
  surface(koi: readonly Surfacer[], t: number) {
    for (const k of koi) {
      if (k.mood !== "surface" || k.leaving) {
        this.mouths.delete(k.id);
        continue;
      }
      const next = this.mouths.get(k.id) ?? t;
      if (t < next) continue;
      this.ripple(k.nodes[0]!, k.nodes[1]!, 0.6);
      this.mouths.set(k.id, t + 1.6 + hash3(k.id, Math.floor(t), 3) * 1.2);
    }
    if (t >= this.nextDrop) {
      if (this.nextDrop > 0) this.ripple(rand(0, this.width), rand(0, this.height), 0.35);
      this.nextDrop = t + rand(3, 8);
    }
  }

  ripple(x: number, y: number, strength: number) {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({ x, y, age: 0, strength });
  }
}
