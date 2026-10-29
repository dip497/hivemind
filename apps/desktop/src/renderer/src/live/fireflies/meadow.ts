/**
 * Fireflies' meadow at night: fireflies flying over the grass, flashing. Each of the workspace's
 * agents is a bigger one (setRoster), its kind's light and code its program's. It flies about,
 * flashing its code quickly, while its agent works; drifts, flashing slowly, while it is ready;
 * flies to its agent's tile and hovers beside it, flashing the call (two bright flashes, over and
 * over), while it needs you; and settles in the grass, glowing faintly, when its agent stops or
 * sleeps. A turn that ends well is a bright flash, and the small fireflies round it answer, a wave
 * of light spreading out from it.
 */
import { angleDiff, clamp, rand } from "../math";
import type { Box, Mood } from "../scene";
import { covered, openPoint } from "../steer";
import { CALL, FLASHES, type FireflyKind } from "./kinds";

export interface FireflySpec {
  key: string;
  kind: FireflyKind;
  size: number;
  mood: Mood;
}

export interface Firefly {
  id: number;
  key: string;
  kind: FireflyKind;
  size: number;
  mood: Mood;
  /** Its agent closed: it flies off, and is dropped once out of sight. */
  leaving: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Which way it faces: 1 right, -1 left. */
  facing: 1 | -1;
  /** Where in its code it starts, so two of a kind do not flash as one. */
  offset: number;
  /** 0 to 1: a turn's bright flash, fading. */
  glow: number;
  /** Settled in the grass. */
  perched: boolean;
  goal: { x: number; y: number } | null;
  goalAt: number;
}

/** One of the meadow's small fireflies. */
export interface Mote {
  x: number;
  y: number;
  /** Its heading and speed. */
  heading: number;
  speed: number;
  /** Its own slow blink: how often, and where in it. */
  period: number;
  offset: number;
  /** 0 to 1: its answer to a turn's flash, fading. */
  answer: number;
}

/** A turn's flash spreading out from the firefly that made it: the motes it reaches answer. */
export interface Wave {
  x: number;
  y: number;
  age: number;
}

/** How fast a wave of answers spreads, in px/s. */
export const WAVE_SPEED = 170;

/** Per mood: how fast it flies, and how often it picks somewhere new to go (seconds). */
const MOODS: Record<Mood, { speed: number; every: [number, number] }> = {
  hunt: { speed: 70, every: [4, 7] },
  cruise: { speed: 28, every: [8, 14] },
  surface: { speed: 140, every: [0, 0] },
  rest: { speed: 30, every: [0, 0] },
};

export class Meadow {
  width = 0;
  height = 0;
  time = 0;
  flies: Firefly[] = [];
  motes: Mote[] = [];
  waves: Wave[] = [];
  pointer = { x: 0, y: 0, active: false };
  private boxes: Box[] = [];
  private tileBox = new Map<string, Box>();
  private nextId = 1;

  resize(width: number, height: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    const n = clamp(Math.round((width * height) / 22000), 24, 90);
    if (first || Math.abs(this.motes.length - n) > n * 0.25) {
      this.motes = Array.from({ length: n }, () => ({
        x: rand(0, width), y: rand(height * 0.3, height * 0.95), heading: rand(0, Math.PI * 2), speed: rand(8, 20),
        period: rand(3, 8), offset: rand(0, 8), answer: 0,
      }));
    }
  }

  /** How bright an agent's firefly is now, 0 to 1. */
  light(f: Firefly) {
    const t = this.time + f.offset;
    const own = f.leaving ? 0.25
      : f.mood === "surface" ? CALL(t)
      : f.mood === "hunt" ? FLASHES[f.kind](t * 1.35)
      : f.mood === "cruise" ? 0.8 * FLASHES[f.kind](t)
      : 0.14 + 0.1 * Math.sin(t * 0.8);
    return clamp(own + f.glow, 0, 1);
  }

  /** How bright a small firefly is now, 0 to 1: its own slow blink, or its answer. */
  moteLight(m: Mote) {
    const p = ((this.time + m.offset) % m.period) / 0.45;
    const own = p > 0 && p < 1 ? Math.sin(Math.PI * p) ** 2 * 0.8 : 0;
    return Math.max(own, m.answer);
  }

  setRoster(specs: FireflySpec[], instant = false) {
    const want = new Map(specs.map((s) => [s.key, s]));
    if (instant) this.flies = this.flies.filter((f) => want.has(f.key));
    for (const f of this.flies) {
      const s = want.get(f.key);
      f.leaving = !s;
      if (!s) continue;
      const surfaced = s.mood === "surface" && f.mood !== "surface";
      if (s.mood !== f.mood) {
        f.goal = null;
        f.perched = false;
      }
      f.mood = s.mood;
      f.kind = s.kind;
      f.size = s.size;
      want.delete(f.key);
      if (instant && surfaced) this.place(f);
    }
    for (const s of want.values()) {
      const f = this.enter(s);
      if (instant) this.place(f);
      this.flies.push(f);
    }
  }

  setBoxes(boxes: Box[]) {
    const half = this.width * this.height * 0.5;
    this.boxes = boxes.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) < half);
    this.tileBox = new Map();
    for (const b of boxes) if (b.key) this.tileBox.set(b.key, b);
  }

  /** Its agent finished a turn well: it flashes, and the small fireflies round it answer. */
  finished(key: string) {
    const f = this.flies.find((x) => x.key === key && !x.leaving);
    if (!f) return;
    f.glow = 1;
    this.waves.push({ x: f.x, y: f.y, age: 0 });
  }

  /** A click in the meadow: the fireflies near it scatter, flashing. */
  splash(x: number, y: number) {
    for (const m of this.motes) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d > 200) continue;
      m.heading = Math.atan2(m.y - y, m.x - x);
      m.speed = 60;
      m.answer = Math.max(m.answer, 1 - d / 200);
    }
    for (const f of this.flies) if (Math.hypot(f.x - x, f.y - y) < 200) f.glow = Math.max(f.glow, 0.5);
  }

  /** A new agent's firefly, flying in from a side. */
  private enter(s: FireflySpec): Firefly {
    const left = Math.random() < 0.5;
    return {
      id: this.nextId++, key: s.key, kind: s.kind, size: s.size, mood: s.mood, leaving: false,
      x: left ? -20 : this.width + 20, y: rand(this.height * 0.3, this.height * 0.7), vx: left ? 40 : -40, vy: 0,
      facing: left ? 1 : -1, offset: rand(0, 10), glow: 0, perched: false, goal: null, goalAt: 0,
    };
  }

  /** Put a firefly where its mood has it, at once. */
  private place(f: Firefly) {
    const p = this.goalOf(f) ?? openPoint(this.boxes, this.width, this.height, 0.2, 0.75, { x: this.width / 2, y: this.height / 2 });
    f.x = p.x;
    f.y = p.y;
    f.vx = f.vy = 0;
    f.perched = f.mood === "rest";
    f.goal = p;
  }

  /** Where its mood sends it: beside its agent's tile while it needs you (null when the tile is not
   *  in sight), into the grass to rest. Null to roam. */
  private goalOf(f: Firefly) {
    const { width: W, height: H } = this;
    if (f.mood === "surface") {
      const tile = this.tileBox.get(f.key);
      if (!tile) return null;
      // By its top corner on the side with room, else by the other, else over or under it: the
      // first in the window and clear of the other tiles.
      const right = W - tile.x1 > tile.x0;
      const spots = [
        { x: right ? tile.x1 + 30 : tile.x0 - 30, y: tile.y0 + 24 },
        { x: right ? tile.x0 - 30 : tile.x1 + 30, y: tile.y0 + 24 },
        { x: (tile.x0 + tile.x1) / 2, y: tile.y0 - 30 },
        { x: (tile.x0 + tile.x1) / 2, y: tile.y1 + 30 },
      ];
      const others = this.boxes.filter((b) => b !== tile && b.key !== f.key);
      const spot = spots.find((p) => p.x > 12 && p.x < W - 12 && p.y > 12 && p.y < H - 12 && !covered(others, p.x, p.y, 20)) ?? spots[0]!;
      return { x: clamp(spot.x, 12, W - 12), y: clamp(spot.y, 12, H - 12) };
    }
    if (f.mood === "rest") return f.goal && f.goal.y > H * 0.8 ? f.goal : { x: rand(W * 0.05, W * 0.95), y: rand(H * 0.88, H * 0.93) };
    return null;
  }

  step(dt: number) {
    this.time += dt;
    for (const f of this.flies) this.fly(f, dt);
    const { width: W } = this;
    const gone = (f: Firefly) => f.leaving && (f.x < -40 || f.x > W + 40);
    if (this.flies.some(gone)) this.flies = this.flies.filter((f) => !gone(f));
    this.drift(dt);
  }

  private fly(f: Firefly, dt: number) {
    const { width: W, height: H, time } = this;
    f.glow = Math.max(0, f.glow - dt * 0.8);
    const mood = MOODS[f.mood];
    let speed = mood.speed;
    if (f.leaving) {
      f.goal = { x: f.x < W / 2 ? -60 : W + 60, y: f.y };
      speed = 90;
    } else {
      const set = this.goalOf(f);
      if (set) f.goal = set;
      else if (!f.goal || time > f.goalAt || Math.hypot(f.goal.x - f.x, f.goal.y - f.y) < 20) {
        f.goal = openPoint(this.boxes, W, H, 0.15, 0.78, { x: f.x, y: f.y });
        f.goalAt = time + rand(mood.every[0], mood.every[1]);
      }
    }
    const gx = f.goal!.x - f.x;
    const gy = f.goal!.y - f.y;
    const far = Math.hypot(gx, gy) || 1;
    // Settled in the grass, it stays.
    if (f.mood === "rest" && !f.leaving && (f.perched || far < 6)) {
      f.perched = true;
      f.vx = f.vy = 0;
      return;
    }
    // Close to where it is going it slows; it never flies quite straight.
    const slow = clamp(far / 60, 0.15, 1);
    const wobble = Math.sin(time * 3.1 + f.id * 1.7) * 0.5;
    const a = Math.atan2(gy, gx) + wobble * (f.mood === "surface" && far < 40 ? 0 : 1);
    let ax = (Math.cos(a) * speed * slow - f.vx) * 2.2;
    let ay = (Math.sin(a) * speed * slow - f.vy) * 2.2;
    // Hovering by its tile, a small loop.
    if (f.mood === "surface" && far < 40) {
      ax += Math.cos(time * 2.4 + f.id) * 30;
      ay += Math.sin(time * 4.8 + f.id) * 20;
    }
    // Off the tiles and panels: pushed away from close by, out if under one.
    if (!f.leaving) {
      for (const b of this.boxes) {
        const dx = f.x < b.x0 ? f.x - b.x0 : f.x > b.x1 ? f.x - b.x1 : 0;
        const dy = f.y < b.y0 ? f.y - b.y0 : f.y > b.y1 ? f.y - b.y1 : 0;
        if (dx === 0 && dy === 0) {
          const near = Math.min(f.x - b.x0, b.x1 - f.x, f.y - b.y0, b.y1 - f.y);
          if (near === f.x - b.x0) ax -= 400;
          else if (near === b.x1 - f.x) ax += 400;
          else if (near === f.y - b.y0) ay -= 400;
          else ay += 400;
          continue;
        }
        const d = Math.hypot(dx, dy);
        if (d < 18) {
          ax += (dx / d) * (1 - d / 18) * 300;
          ay += (dy / d) * (1 - d / 18) * 300;
        }
      }
      if (f.x < 10) ax += 200;
      if (f.x > W - 10) ax -= 200;
      if (f.y < 10) ay += 200;
      if (f.y > H - 10) ay -= 200;
    }
    f.vx += ax * dt;
    f.vy += ay * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.vx > 4) f.facing = 1;
    else if (f.vx < -4) f.facing = -1;
  }

  private drift(dt: number) {
    const { width: W, height: H, time, pointer } = this;
    for (const w of this.waves) w.age += dt;
    const reach = Math.hypot(W, H);
    if (this.waves.some((w) => w.age * WAVE_SPEED > reach)) this.waves = this.waves.filter((w) => w.age * WAVE_SPEED <= reach);
    for (const m of this.motes) {
      // A wave reaching it: it answers.
      for (const w of this.waves) {
        const d = Math.hypot(m.x - w.x, m.y - w.y);
        if (Math.abs(d - w.age * WAVE_SPEED) < WAVE_SPEED * dt * 1.5) m.answer = 1;
      }
      m.answer = Math.max(0, m.answer - dt * 1.4);
      m.heading += Math.sin(time * 0.7 + m.offset * 3) * dt * 1.2;
      // Over the meadow, mostly: back from the top and the sides.
      if (m.y < H * 0.3) m.heading += angleDiff(m.heading, Math.PI / 2) * dt * 0.8;
      if (m.y > H * 0.95) m.heading += angleDiff(m.heading, -Math.PI / 2) * dt * 0.8;
      if (pointer.active && Math.hypot(m.x - pointer.x, m.y - pointer.y) < 70) m.heading = Math.atan2(m.y - pointer.y, m.x - pointer.x);
      m.speed += (rand(8, 20) - m.speed) * dt * 0.5;
      m.x += Math.cos(m.heading) * m.speed * dt;
      m.y += Math.sin(m.heading) * m.speed * dt;
      if (m.x < -8) m.x += W + 16;
      else if (m.x > W + 8) m.x -= W + 16;
      m.y = clamp(m.y, 4, H - 4);
    }
  }
}
