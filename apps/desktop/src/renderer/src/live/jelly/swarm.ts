/**
 * Jellyfish's water: jellies that swim by beating their bells, each a push along the way the bell
 * faces, then a drift as it opens again, and that sink a little when they stop; their tentacles
 * trail behind them and sway. Marine snow falls slowly through it all, and a beat stirs it.
 *
 * Each jelly is one of the workspace's agents (setRoster). It beats fast and roams while its agent
 * works, drifts while it is ready, comes up beside its agent's tile and holds there, glowing, while
 * it needs you, and sinks toward the bottom, barely beating, when its agent stops or sleeps. A turn
 * that ends well is a flash of its light.
 */
import { angleDiff, clamp, rand } from "../math";
import type { Box, Mood } from "../scene";
import { openPoint } from "../steer";
import { JELLY_SHAPES, type JellyKind, type JellyShape } from "./kinds";

/** One agent's jelly: `key` is its tile, `size` is relative to the biggest. */
export interface JellySpec {
  key: string;
  kind: JellyKind;
  size: number;
  mood: Mood;
}

/** Per mood: how fast its bell beats against its kind's cruise, how hard, and how near it swims
 *  (0 far and dim, 1 near and bright). */
const MOODS: Record<Mood, { rate: number; thrust: number; depth: number }> = {
  hunt: { rate: 1.6, thrust: 1.15, depth: 0.85 },
  cruise: { rate: 1, thrust: 0.85, depth: 0.65 },
  surface: { rate: 1.25, thrust: 0.9, depth: 1 },
  rest: { rate: 0.35, thrust: 0.45, depth: 0.35 },
};

/** Nodes in a tentacle, and in an oral arm. */
export const TENTACLE_NODES = 12;
export const ARM_NODES = 8;
/** The furthest a jelly leans from upright: it swims up and across, and sinks to go straight down.
 *  Resting, it hardly leans; called to its tile, it leans as far as it must and swims there, down
 *  and across too. */
const MAX_TILT = 1.3;
const RESTING_TILT = 0.6;
const HURRIED_TILT = 1.2;
/** How fast a bell's push fades in the water. */
const DRAG = 1.2;

export interface Strand {
  /** [x0, y0, x1, y1, …], node 0 on the bell. */
  nodes: Float32Array;
  /** Where on the rim it hangs from, -1 to 1 across, and whether it is an oral arm. */
  anchor: number;
  arm: boolean;
  /** The length of each of its segments, in px. */
  seg: number;
}

export interface Jelly {
  id: number;
  key: string;
  kind: JellyKind;
  shape: JellyShape;
  size: number;
  mood: Mood;
  /** Its agent closed: it swims off, and is dropped once out of sight. */
  leaving: boolean;
  /** The middle of its bell's rim, in px, and its velocity. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Its lean from upright (radians, + to the right): its bell faces up and over by this much. */
  tilt: number;
  /** Its beat: `phase` 0 to 1 through one, `beat` how closed its bell is (0 open, 1 closed). */
  phase: number;
  beat: number;
  /** Its size in px against which the kind's shape is set (`unit` × size × nearness). */
  length: number;
  depth: number;
  /** 0 to 1: a flash of its own light, fading. */
  glow: number;
  goal: { x: number; y: number } | null;
  goalAt: number;
  strands: Strand[];
}

/** A speck of marine snow. `z` is how near it is, 0.3 to 1. */
export interface Mote {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
}

/** How closed a bell is through a beat: shut quickly, open slowly. */
export function beatAt(phase: number) {
  return phase < 0.3 ? Math.sin((phase / 0.3) * (Math.PI / 2)) : Math.cos(((phase - 0.3) / 0.7) * (Math.PI / 2)) ** 2;
}

/** The bell's half-width and height for a jelly as it is now. */
export function bellOf(j: Pick<Jelly, "shape" | "length" | "beat">) {
  return { w: j.shape.w * j.length * (1 - 0.18 * j.beat), h: j.shape.h * j.length * (1 + 0.15 * j.beat) };
}

export class Swarm {
  width = 0;
  height = 0;
  time = 0;
  jellies: Jelly[] = [];
  snow: Mote[] = [];
  pointer = { x: 0, y: 0, active: false };
  private boxes: Box[] = [];
  private tileBox = new Map<string, Box>();
  private nextId = 1;

  resize(width: number, height: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    const n = clamp(Math.round((width * height) / 2600), 120, 900);
    if (first || Math.abs(this.snow.length - n) > n * 0.2) {
      this.snow = Array.from({ length: n }, () => ({ x: rand(0, width), y: rand(0, height), z: rand(0.3, 1), vx: 0, vy: 0 }));
    }
  }

  /** The biggest jelly's size: a share of the window, less of it when many swim at once. */
  private unit() {
    let n = 0;
    for (const j of this.jellies) if (!j.leaving) n++;
    return clamp(Math.min(this.width, this.height) * 0.12, 64, 160) * (n > 5 ? Math.sqrt(5 / n) : 1);
  }

  /** The agents' jellies. A new key swims up from below, a missing one swims off, and the rest
   *  take their new mood. `instant`, for a still picture: each is put where its mood has it. */
  setRoster(specs: JellySpec[], instant = false) {
    const want = new Map(specs.map((s) => [s.key, s]));
    if (instant) this.jellies = this.jellies.filter((j) => want.has(j.key));
    for (const j of this.jellies) {
      const s = want.get(j.key);
      j.leaving = !s;
      if (!s) continue;
      const surfaced = s.mood === "surface" && j.mood !== "surface";
      j.mood = s.mood;
      j.size = s.size;
      if (j.kind !== s.kind) {
        j.kind = s.kind;
        j.shape = JELLY_SHAPES[s.kind];
        j.strands = this.strandsOf(j);
      }
      want.delete(j.key);
      if (instant) {
        j.depth = MOODS[j.mood].depth;
        if (surfaced) this.place(j);
      }
    }
    for (const s of want.values()) {
      const j = this.enter(s);
      if (instant) this.place(j);
      this.jellies.push(j);
    }
    if (instant) this.jellies.sort((a, b) => a.depth - b.depth);
  }

  /** Where the tiles and panels are. Jellies keep to the water between them, and one whose agent
   *  needs you holds beside that agent's tile. A box over half the window is let be. */
  setBoxes(boxes: Box[]) {
    const half = this.width * this.height * 0.5;
    this.boxes = boxes.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) < half);
    this.tileBox = new Map();
    for (const b of boxes) if (b.key) this.tileBox.set(b.key, b);
  }

  /** Its agent finished a turn well: it flashes its light and beats. */
  finished(key: string) {
    const j = this.jellies.find((x) => x.key === key && !x.leaving);
    if (!j) return;
    j.glow = 1;
    j.phase = 0;
  }

  /** A click on the water: the snow round it scatters, and the jellies near it start and glow. */
  splash(x: number, y: number) {
    for (const m of this.snow) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d > 220 || d < 1) continue;
      const k = (1 - d / 220) * 90;
      m.vx += ((m.x - x) / d) * k;
      m.vy += ((m.y - y) / d) * k;
    }
    for (const j of this.jellies) {
      if (Math.hypot(j.x - x, j.y - y) > 260) continue;
      j.glow = Math.max(j.glow, 0.5);
      j.phase = 0;
    }
  }

  private strandsOf(j: Jelly): Strand[] {
    const out: Strand[] = [];
    const { tentacles, reach, arms, armReach } = j.shape;
    for (let i = 0; i < tentacles; i++) {
      const anchor = tentacles === 1 ? 0 : -0.92 + (1.84 * i) / (tentacles - 1);
      out.push({ nodes: new Float32Array(TENTACLE_NODES * 2), anchor, arm: false, seg: (reach * j.length) / (TENTACLE_NODES - 1) });
    }
    for (let i = 0; i < arms; i++) {
      const anchor = arms === 1 ? 0 : -0.32 + (0.64 * i) / (arms - 1);
      out.push({ nodes: new Float32Array(ARM_NODES * 2), anchor, arm: true, seg: (armReach * j.length) / (ARM_NODES - 1) });
    }
    for (const s of out) this.hang(j, s);
    return out;
  }

  /** A strand hanging straight down from its place on the rim. */
  private hang(j: Jelly, s: Strand) {
    const { w } = bellOf(j);
    const ax = j.x + Math.cos(j.tilt) * s.anchor * w;
    const ay = j.y + Math.sin(j.tilt) * s.anchor * w;
    for (let k = 0; k < s.nodes.length / 2; k++) {
      s.nodes[k * 2] = ax - Math.sin(j.tilt) * s.seg * k;
      s.nodes[k * 2 + 1] = ay + Math.cos(j.tilt) * s.seg * k;
    }
  }

  /** A jelly for `s`, below the window, rising into it. */
  private enter(s: JellySpec): Jelly {
    const shape = JELLY_SHAPES[s.kind];
    const id = this.nextId++;
    const j: Jelly = {
      id, key: s.key, kind: s.kind, shape, size: s.size, mood: s.mood, leaving: false,
      x: rand(this.width * 0.15, this.width * 0.85), y: this.height + this.unit() * 0.6,
      vx: 0, vy: -20, tilt: rand(-0.3, 0.3), phase: Math.random(), beat: 0,
      length: this.unit() * s.size, depth: MOODS[s.mood].depth, glow: 0,
      goal: null, goalAt: 0, strands: [],
    };
    j.strands = this.strandsOf(j);
    return j;
  }

  /** Put a jelly where its mood has it, at once. */
  private place(j: Jelly) {
    j.length = this.unit() * j.size * (0.8 + 0.3 * j.depth);
    const hold = j.mood === "surface" ? this.holdBy(j) : null;
    const p = hold ?? openPoint(this.boxes, this.width, this.height, j.mood === "rest" ? 0.7 : 0.15, j.mood === "rest" ? 0.88 : 0.8, { x: this.width / 2, y: this.height / 2 });
    j.x = p.x;
    j.y = p.y;
    j.vx = j.vy = 0;
    j.tilt = 0;
    j.goal = null;
    for (const s of j.strands) this.hang(j, s);
  }

  /** Where a jelly whose agent needs you holds: over its agent's tile, its tentacles just above
   *  the tile's top edge, or beside it when there is no room above. Null when the tile is not in
   *  sight. */
  private holdBy(j: Jelly) {
    const tile = this.tileBox.get(j.key);
    if (!tile) return null;
    const L = j.length;
    const hang = Math.max(j.shape.reach, j.shape.armReach) * L;
    const above = tile.y0 - hang - L * 0.15;
    const top = j.shape.h * L + 8;
    if (above > top) return { x: clamp((tile.x0 + tile.x1) / 2, j.shape.w * L, this.width - j.shape.w * L), y: above };
    const side = tile.x0 > this.width - tile.x1 ? tile.x0 - j.shape.w * L * 1.6 : tile.x1 + j.shape.w * L * 1.6;
    return { x: clamp(side, j.shape.w * L, this.width - j.shape.w * L), y: clamp((tile.y0 + tile.y1) / 2, top, this.height - hang) };
  }

  step(dt: number) {
    this.time += dt;
    const unit = this.unit();
    for (const j of this.jellies) this.stepJelly(j, dt, unit);
    this.stepSnow(dt);
    const gone = (j: Jelly) => j.leaving && (j.x < -j.length * 2 || j.x > this.width + j.length * 2 || j.y > this.height + j.length * 3);
    if (this.jellies.some(gone)) this.jellies = this.jellies.filter((j) => !gone(j));
    // Nearer jellies draw last, over the far ones.
    this.jellies.sort((a, b) => a.depth - b.depth);
  }

  private stepJelly(j: Jelly, dt: number, unit: number) {
    const { width: W, height: H, time } = this;
    const mood = MOODS[j.mood];
    j.depth += (mood.depth - j.depth) * Math.min(1, dt * 0.6);
    // Seen from the front, a jelly that comes near grows.
    const L = (j.length = unit * j.size * (0.8 + 0.3 * j.depth));
    j.glow = Math.max(0, j.glow - dt * 0.9);

    // Where it is going.
    let hold: { x: number; y: number } | null = null;
    if (j.leaving) {
      j.goal = { x: j.x < W / 2 ? -L * 3 : W + L * 3, y: j.y - L };
    } else if (j.mood === "surface" && (hold = this.holdBy(j))) {
      j.goal = hold;
    } else if (!j.goal || time > j.goalAt || Math.hypot(j.goal.x - j.x, j.goal.y - j.y) < L * 0.6) {
      // Somewhere well away and on the way it is going, so it crosses the water in long drifts.
      const rest = j.mood === "rest";
      j.goal = openPoint(this.boxes, W, H, rest ? 0.72 : 0.12, rest ? 0.9 : 0.82, { x: j.x, y: j.y, heading: Math.atan2(j.vy, j.vx), reach: L * 3 });
      j.goalAt = time + rand(j.mood === "hunt" ? 9 : 14, j.mood === "hunt" ? 15 : 22);
    }
    const gx = j.goal!.x - j.x;
    const gy = j.goal!.y - j.y;
    const far = Math.hypot(gx, gy);

    // Called to its tile from afar, it beats hard to get there, as a shark hurries.
    const holding = hold !== null && far < L * 0.8;
    const hurry = j.leaving || (hold !== null && far > L * 1.5);
    // Lean toward it. To go straight down it stops beating, but for a soft beat to lean it
    // across, and sinks.
    const below = gy > L * 0.5 && Math.abs(gx) < gy * 0.45;
    const most = hurry ? HURRIED_TILT : j.mood === "rest" ? RESTING_TILT : MAX_TILT;
    const want = clamp(Math.atan2(gx, -gy), -most, most) * (below ? 0.6 : 1);
    j.tilt += clamp(angleDiff(j.tilt, want), -(hurry ? 1.4 : 0.7) * dt, (hurry ? 1.4 : 0.7) * dt);

    // The beat. Holding by its tile, it beats only to stay up: it sinks a little, then rises.
    const rate = j.shape.rate * mood.rate * (hurry ? 2 : 1);
    j.phase = (j.phase + rate * dt) % 1;
    const was = j.beat;
    j.beat = beatAt(j.phase);
    const closing = j.beat > was;
    // A beat lifts it, so one above where it is going beats less, and sinks between: it keeps to
    // its goal's height as it goes across.
    const push = (holding ? (gy < 0 ? 1 : 0) : below ? 0.15 : gy > 0 ? clamp(1 - gy / L, 0.2, 1) : 1) * mood.thrust;
    if (closing) {
      // A beat is half a bell-length of speed, given over the time the bell takes to close.
      const accel = ((0.5 * L * push) / (0.3 / rate)) * (hurry ? 1.8 : 1);
      j.vx += Math.sin(j.tilt) * accel * dt;
      j.vy -= Math.cos(j.tilt) * accel * dt;
    }
    // It sinks a little, more when it is going down, and the water slows it.
    j.vy += (below ? 30 : gy > L * 0.3 ? 22 : 6) * dt;
    j.vx -= j.vx * DRAG * dt;
    j.vy -= j.vy * DRAG * dt;

    // Out from under a tile, and off another jelly, and back from the window's edges.
    if (!j.leaving) {
      // A tile pushes a jelly away from a bell's width out; one under a tile is pushed out by its
      // nearest side. Not its own tile while it holds over it.
      const cy = j.y - j.shape.h * L * 0.5;
      const pad = j.shape.w * L * 1.1 + 12;
      for (const b of this.boxes) {
        if (b.key === j.key && j.mood === "surface") continue;
        const dx = j.x < b.x0 ? j.x - b.x0 : j.x > b.x1 ? j.x - b.x1 : 0;
        const dy = cy < b.y0 ? cy - b.y0 : cy > b.y1 ? cy - b.y1 : 0;
        if (dx === 0 && dy === 0) {
          const near = Math.min(j.x - b.x0, b.x1 - j.x, cy - b.y0, b.y1 - cy);
          const k = 160 * dt;
          if (near === j.x - b.x0) j.vx -= k;
          else if (near === b.x1 - j.x) j.vx += k;
          else if (near === cy - b.y0) j.vy -= k;
          else j.vy += k;
          continue;
        }
        const d = Math.hypot(dx, dy);
        if (d >= pad) continue;
        const k = (1 - d / pad) * 140 * dt;
        j.vx += (dx / d) * k;
        j.vy += (dy / d) * k;
      }
      for (const o of this.jellies) {
        if (o === j) continue;
        const dx = j.x - o.x;
        const dy = j.y - o.y;
        const d = Math.hypot(dx, dy);
        const room = (j.shape.w * L + o.shape.w * o.length) * 1.1;
        if (d < room && d > 1e-3) {
          j.vx += (dx / d) * (1 - d / room) * 40 * dt;
          j.vy += (dy / d) * (1 - d / room) * 40 * dt;
        }
      }
      const m = j.shape.w * L;
      if (j.x < m) j.vx += (m - j.x) * 2 * dt;
      if (j.x > W - m) j.vx -= (j.x - (W - m)) * 2 * dt;
      const top = j.shape.h * L;
      if (j.y < top) j.vy += (top - j.y) * 2 * dt;
      if (j.y > H - L * 0.2) j.vy -= (j.y - (H - L * 0.2)) * 2 * dt;
    }
    j.x += j.vx * dt;
    j.y += j.vy * dt;
    this.trail(j, dt);
  }

  /** The strands follow the rim: each node keeps its length from the one before, hangs back from
   *  the bell, and sways, more toward its tip. */
  private trail(j: Jelly, dt: number) {
    const { w } = bellOf(j);
    const t = this.time;
    const upX = Math.sin(j.tilt);
    const upY = -Math.cos(j.tilt);
    for (const [n, s] of j.strands.entries()) {
      const nodes = s.nodes;
      const count = nodes.length / 2;
      // A tentacle hangs from the rim, an arm from inside it, a little up.
      const reach = s.arm ? 0.6 : 1;
      nodes[0] = j.x + Math.cos(j.tilt) * s.anchor * w * reach + (s.arm ? upX * w * 0.1 : 0);
      nodes[1] = j.y + Math.sin(j.tilt) * s.anchor * w * reach + (s.arm ? upY * w * 0.1 : 0);
      for (let k = 1; k < count; k++) {
        const px = nodes[(k - 1) * 2]!;
        const py = nodes[(k - 1) * 2 + 1]!;
        const along = k / (count - 1);
        // Hang back from the bell, and sway across.
        const sway = Math.sin(t * (s.arm ? 1.1 : 1.6) + n * 1.7 - k * 0.55) * s.seg * 0.5 * along;
        let x = nodes[k * 2]! - upX * s.seg * 0.35 * dt * 10 + Math.cos(j.tilt) * sway * dt * 6;
        let y = nodes[k * 2 + 1]! - upY * s.seg * 0.35 * dt * 10 + Math.sin(j.tilt) * sway * dt * 6;
        const d = Math.hypot(x - px, y - py) || 1;
        x = px + ((x - px) / d) * s.seg;
        y = py + ((y - py) / d) * s.seg;
        nodes[k * 2] = x;
        nodes[k * 2 + 1] = y;
      }
    }
  }

  private stepSnow(dt: number) {
    const { width: W, height: H, time: t, pointer } = this;
    const beating = this.jellies.filter((j) => j.phase < 0.3);
    for (const m of this.snow) {
      // It falls slowly, nearer specks faster, and wavers.
      const fall = 3 + 7 * m.z;
      m.vx -= m.vx * 1.5 * dt;
      m.vy -= m.vy * 1.5 * dt;
      // A beat pushes the water out from under the bell.
      for (const j of beating) {
        const dx = m.x - j.x;
        const dy = m.y - j.y;
        const R = j.shape.w * j.length * 1.8;
        const d = Math.hypot(dx, dy);
        if (d < R && d > 1) {
          m.vx += (dx / d) * (1 - d / R) * 40 * dt;
          m.vy += (dy / d) * (1 - d / R) * 40 * dt;
        }
      }
      if (pointer.active) {
        const dx = m.x - pointer.x;
        const dy = m.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < 80 && d > 1) {
          m.vx += (dx / d) * (1 - d / 80) * 60 * dt;
          m.vy += (dy / d) * (1 - d / 80) * 60 * dt;
        }
      }
      m.x += (m.vx + Math.sin(t * 0.4 + m.y * 0.02) * 3 * m.z) * dt;
      m.y += (m.vy + fall) * dt;
      if (m.y > H + 4) {
        m.y = -4;
        m.x = rand(0, W);
      }
      if (m.x < -4) m.x += W + 8;
      else if (m.x > W + 4) m.x -= W + 8;
    }
  }
}

