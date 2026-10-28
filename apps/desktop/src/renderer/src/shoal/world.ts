/**
 * Artificial-life sim behind the canvas: tiny fish schools and the sharks that hunt them.
 *
 * Fish: Reynolds boids (separation / alignment / cohesion) in Couzin-style
 * zones, with a blind spot behind each fish. Alarm spreads from fish to fish
 * through the school (a "wave of agitation"), so a whole school bolts even
 * when only its edge can see the shark. Fleeing fish break sideways around the
 * shark's path, which gives the fountain effect seen in real bait balls.
 *
 * Sharks: Reynolds steering (wander + pursuit + separation) on a
 * follow-the-leader spine. They prefer fish in sparse spots, since dense
 * schools confuse predators, so stragglers get picked off. Eaten fish come
 * back later as new schools swimming in from the edges, which keeps the
 * population steady.
 *
 * Ported from stackedlol/ascii-sharks (MIT, see LICENSE here). What changed for Hivemind: each
 * shark is one of the workspace's agents (setRoster), and its agent's status sets its mood. It
 * swims in when the agent starts and off when it closes; the original kept four sharks for good
 * and steered them clear of a centred headline.
 */
import { angleDiff, clamp, current, rand, randInt, TAU } from "./math";
import { pickSpecies, SPECIES } from "./species";

export const SHARK_NODES = 20;

export type SharkKind = "classic" | "hammerhead" | "zebra" | "tiger" | "greathammer" | "mako" | "thresher" | "nurse";

/** What a shark does, from its agent: hunt (at work), cruise (ready), come up close (it needs
 *  you) or rest on the bottom (stopped, failed or asleep). */
export type Mood = "hunt" | "cruise" | "surface" | "rest";

/** One agent's shark: `key` is its tile, `size` is relative to the biggest. */
export interface SharkSpec {
  key: string;
  kind: SharkKind;
  size: number;
  mood: Mood;
}

/** Per mood: how near the shark swims (0 far and dim, 1 near and bright; nearer is bigger, as
 *  seen from above) and its pace against a cruise. */
const MOODS: Record<Mood, { depth: number; pace: number }> = {
  hunt: { depth: 0.85, pace: 1 },
  cruise: { depth: 0.6, pace: 0.8 },
  surface: { depth: 1, pace: 0.55 },
  rest: { depth: 0.3, pace: 0.35 },
};

export interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  species: number;
  /** 0 calm → 1 panicking. Spreads to neighbours. */
  alarm: number;
  alive: boolean;
  respawnAt: number;
  /** Tail-beat phase. */
  phase: number;
  /** Smoothed angular velocity (rad/s); hard turns flash silver. */
  turn: number;
  /** 0.55 far → 1 near. */
  depth: number;
  /** Rotation sense shared by a school when it mills into a bait ball. */
  millDir: 1 | -1;
}

export interface Shark {
  id: number;
  key: string;
  kind: SharkKind;
  size: number;
  mood: Mood;
  /** Its agent closed: it swims off and is dropped once out of sight. */
  leaving: boolean;
  length: number;
  /** Spine positions, snout first: [x0, y0, x1, y1, ...]. */
  nodes: Float32Array;
  heading: number;
  speed: number;
  /** Tail-beat phase; drives the body wave in the renderer. */
  phase: number;
  /** Smoothed angular velocity (rad/s); the shark banks its fins into turns. */
  turn: number;
  hunger: number;
  wander: number;
  /** Which way it circles a tile, and turns along the bottom. */
  orbitDir: 1 | -1;
  target: Fish | null;
  retargetAt: number;
  /** 0 far / dim → 1 near / bright. */
  depth: number;
  /** Where it is swimming to in the open water, and until when before it picks another. */
  goal: { x: number; y: number } | null;
  goalAt: number;
}

export interface WorldEvent {
  /** `bite`: its agent finished a turn. */
  kind: "eat" | "splash" | "bite";
  x: number;
  y: number;
}

/** A box on the screen the scene keeps its life out from under: a tile or a panel. `key` is a tile's id. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  key?: string;
}

const FISH_SEPARATION_K = 420;
const FISH_ALIGN_K = 1.4;
const FISH_COHESION_K = 1;
const FISH_FLEE_K = 1100;
const BLIND_COS = -0.6; // ~127° either side of the heading is visible

export class World {
  width = 0;
  height = 0;
  time = 0;
  fish: Fish[] = [];
  sharks: Shark[] = [];
  events: WorldEvent[] = [];
  pointer = { x: 0, y: 0, active: false };

  /** Fish neighbourhood radius; the spatial hash bucket size matches it. */
  private perception = 60;
  /** Per-species personal space in px (x, y). */
  private sepX: number[] = [];
  private sepY: number[] = [];
  private foreignSep = 40;
  private bucketCols = 0;
  private bucketRows = 0;
  private bucketHead = new Int32Array(0);
  private bucketCount = new Uint16Array(0);
  private bucketNext = new Int32Array(0);
  private lastSpawn = 0;
  private tmp = { x: 0, y: 0 };
  private nextId = 1;
  private boxes: Box[] = [];
  private tileBox = new Map<string, Box>();

  /** fishCount overrides the area-based population. */
  constructor(private fishCount?: number) {}

  resize(width: number, height: number, cellW: number, cellH: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    // Spacing is set in grid cells so every fish lands in its own cell.
    this.sepX = SPECIES.map((sp) => sp.spacing[0] * cellW);
    this.sepY = SPECIES.map((sp) => sp.spacing[1] * cellH);
    this.perception = Math.max(cellH * 3, cellW * 5.5);
    this.foreignSep = cellW * 3;

    if (first || this.fish.length === 0) {
      this.seedFish();
      return;
    }
    for (const f of this.fish) {
      f.x = clamp(f.x, 0, width);
      f.y = clamp(f.y, 0, height);
    }
  }

  /** The biggest shark's length: the original's share of the window, and less of it when many
   *  swim at once. */
  private unit() {
    let n = 0;
    for (const s of this.sharks) if (!s.leaving) n++;
    return clamp(Math.min(this.width, this.height) * 0.44, 170, 430) * (n > 4 ? Math.sqrt(4 / n) : 1);
  }

  seedFish() {
    const { width: W, height: H } = this;
    const total = this.fishCount ?? clamp(Math.round((W * H) / 4400), 85, 340);
    this.fish = [];
    while (this.fish.length < total) {
      const species = pickSpecies();
      const sp = SPECIES[species]!;
      const size = Math.min(randInt(sp.schoolSize[0], sp.schoolSize[1]), total - this.fish.length);
      const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const cx = rand(W * 0.06, W * 0.94);
      const cy = rand(H * 0.08, H * 0.92);
      // Mostly level headings: fish cruise sideways far more than up or down.
      const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
      for (let k = 0; k < size; k++) {
        this.fish.push({
          x: cx + rand(-1, 1) * this.sepX[species]! * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.sepY[species]! * Math.sqrt(size) * 0.6,
          vx: Math.cos(dir) * sp.cruise,
          vy: Math.sin(dir) * sp.cruise,
          species,
          alarm: 0,
          alive: true,
          respawnAt: 0,
          phase: rand(0, TAU),
          turn: 0,
          depth: rand(0.55, 1),
          millDir,
        });
      }
    }
    this.bucketNext = new Int32Array(this.fish.length);
  }

  /** The agents' sharks. A new key swims in from an edge, a missing one swims off, and the rest
   *  take their new mood. `instant`, for a still picture: a missing one is gone at once, a new one
   *  is put straight into the open water, one that comes to need you is put beside its tile, and
   *  each is already as near as its mood has it; no other shark moves. */
  setRoster(specs: SharkSpec[], instant = false) {
    const want = new Map(specs.map((s) => [s.key, s]));
    if (instant) this.sharks = this.sharks.filter((sh) => want.has(sh.key));
    for (const sh of this.sharks) {
      const s = want.get(sh.key);
      sh.leaving = !s;
      if (!s) continue;
      const surfaced = s.mood === "surface" && sh.mood !== "surface";
      sh.mood = s.mood;
      sh.kind = s.kind;
      sh.size = s.size;
      want.delete(sh.key);
      if (instant) {
        sh.depth = MOODS[sh.mood].depth;
        if (surfaced) this.place(sh);
      }
    }
    for (const s of want.values()) {
      const sh = this.enter(s);
      if (instant) this.place(sh);
      this.sharks.push(sh);
    }
    if (instant) this.sharks.sort((a, b) => a.depth - b.depth);
  }

  /** Put a shark where its mood has it, at once: on the ring round its tile if it needs you and the
   *  tile is in sight, else in the open water (near the bottom if it rests). */
  private place(sh: Shark) {
    const { width: W, height: H } = this;
    const L = (sh.length = this.unit() * sh.size * (0.8 + 0.3 * sh.depth));
    const tile = sh.mood === "surface" ? this.tileBox.get(sh.key) : undefined;
    let x: number;
    let y: number;
    let heading: number;
    if (tile) {
      // Over the tile's top edge, swimming along it.
      x = clamp((tile.x0 + tile.x1) / 2, L * 0.15, W - L * 0.15);
      y = clamp(tile.y0 - L * 0.3, L * 0.15, H - L * 0.15);
      heading = sh.orbitDir > 0 ? 0 : Math.PI;
    } else {
      ({ x, y } = this.openPoint(sh.mood === "rest" ? 0.72 : 0.08, 0.92, { x: W / 2, y: H / 2 }));
      heading = rand(0, TAU);
    }
    const seg = L / (SHARK_NODES - 1);
    for (let n = 0; n < SHARK_NODES; n++) {
      sh.nodes[n * 2] = x - Math.cos(heading) * seg * n;
      sh.nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
    }
    sh.heading = heading;
    sh.goal = null;
  }

  /** Where the tiles and panels are. The fish and the sharks keep to the water between them, and a
   *  shark whose agent needs you circles that agent's tile. A box over half the window is let be:
   *  under a tile that fills the window there is no open water to keep to. */
  setBoxes(boxes: Box[]) {
    const half = this.width * this.height * 0.5;
    this.boxes = boxes.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) < half);
    this.tileBox = new Map();
    for (const b of boxes) if (b.key) this.tileBox.set(b.key, b);
  }

  private covered(x: number, y: number, pad: number) {
    for (const b of this.boxes) if (x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad) return true;
    return false;
  }

  /** A point in the open water between `top` and `bottom` (shares of the height), and one the
   *  shark at `from` can swim to without passing under a tile if there is one: of a few tries, the
   *  one with the least of its way covered and, given the shark's heading, the least turn to it,
   *  at least `reach` away, so it swims on in long curves instead of doubling back. On a canvas
   *  too full for any try to be clear of the tiles, the try with the most room round it. */
  private openPoint(top: number, bottom: number, from: { x: number; y: number; heading?: number; reach?: number }) {
    const { width: W, height: H } = this;
    let best = { x: W / 2, y: H / 2 };
    let bestCover = Infinity;
    let fallback = best;
    let fallbackRoom = -Infinity;
    const ahead = from.heading !== undefined;
    for (let i = 0; i < 16; i++) {
      const x = rand(W * 0.08, W * 0.92);
      const y = rand(H * top, H * bottom);
      if (this.covered(x, y, 60)) {
        const room = this.roomAt(x, y);
        if (room > fallbackRoom) {
          fallback = { x, y };
          fallbackRoom = room;
        }
        continue;
      }
      let cover = 0;
      for (let k = 1; k < 8; k++) if (this.covered(from.x + ((x - from.x) * k) / 8, from.y + ((y - from.y) * k) / 8, 30)) cover++;
      // A covered step outweighs any turn; a point too near counts as a half turn more.
      if (ahead) cover = cover * 4 + Math.abs(angleDiff(from.heading!, Math.atan2(y - from.y, x - from.x))) + (Math.hypot(x - from.x, y - from.y) < from.reach! ? Math.PI : 0);
      if (cover < bestCover) {
        best = { x, y };
        bestCover = cover;
        if (cover === 0) break;
      }
    }
    return bestCover < Infinity ? best : fallback;
  }

  /** How far a point is from the nearest box or the window's edge; less than 0 under a box, by how
   *  far it is in from that box's nearest side. */
  private roomAt(x: number, y: number) {
    let room = Math.min(x, this.width - x, y, this.height - y);
    for (const b of this.boxes) {
      const inside = x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
      room = Math.min(room, inside ? -Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y) : Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1)));
    }
    return room;
  }

  /** Its agent finished a turn: the shark bites where it is, the fish near it scatter, and it is fed. */
  finished(key: string) {
    const sh = this.sharks.find((s) => s.key === key && !s.leaving);
    if (!sh) return;
    sh.hunger = 0;
    this.events.push({ kind: "bite", x: sh.nodes[0]!, y: sh.nodes[1]! });
    this.scatter(sh.nodes[0]!, sh.nodes[1]!, 160);
  }

  /** A shark for `s`, just off a random edge, heading in. */
  private enter(s: SharkSpec): Shark {
    const { width: W, height: H } = this;
    const length = this.unit() * s.size;
    const side = randInt(0, 3);
    const along = rand(0.2, 0.8);
    const x = side === 0 ? -length * 0.3 : side === 1 ? W + length * 0.3 : along * W;
    const y = side === 2 ? -length * 0.3 : side === 3 ? H + length * 0.3 : along * H;
    const heading = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.4, 0.4);
    const nodes = new Float32Array(SHARK_NODES * 2);
    const seg = length / (SHARK_NODES - 1);
    for (let n = 0; n < SHARK_NODES; n++) {
      nodes[n * 2] = x - Math.cos(heading) * seg * n;
      nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
    }
    const id = this.nextId++;
    return {
      id,
      key: s.key,
      kind: s.kind,
      size: s.size,
      mood: s.mood,
      leaving: false,
      length,
      nodes,
      heading,
      speed: 30,
      phase: rand(0, TAU),
      turn: 0,
      hunger: rand(0.25, 0.75),
      wander: 0,
      orbitDir: id % 2 === 0 ? 1 : -1,
      target: null,
      retargetAt: 0,
      depth: MOODS[s.mood].depth,
      goal: null,
      goalAt: 0,
    };
  }

  splash(x: number, y: number) {
    this.events.push({ kind: "splash", x, y });
    this.scatter(x, y, 240);
  }

  /** Flash expansion: every fish within `r` bolts straight out. */
  private scatter(x: number, y: number, r: number) {
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 1e-3) continue;
      const k = (1 - d / r) * 260;
      f.vx += (dx / d) * k;
      f.vy += (dy / d) * k;
      f.alarm = 1;
    }
  }

  step(dt: number) {
    this.time += dt;
    this.rebuildHash();
    this.stepFish(dt);
    this.stepSharks(dt);
    this.respawn();
    // Nearer sharks draw last, so they swim over the far ones.
    this.sharks.sort((a, b) => a.depth - b.depth);
  }

  private rebuildHash() {
    const size = this.perception;
    const pad = 2;
    this.bucketCols = Math.ceil(this.width / size) + pad * 2;
    this.bucketRows = Math.ceil(this.height / size) + pad * 2;
    const n = this.bucketCols * this.bucketRows;
    if (this.bucketHead.length !== n) {
      this.bucketHead = new Int32Array(n);
      this.bucketCount = new Uint16Array(n);
    }
    this.bucketHead.fill(-1);
    this.bucketCount.fill(0);
    if (this.bucketNext.length !== this.fish.length) {
      this.bucketNext = new Int32Array(this.fish.length);
    }
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i]!;
      if (!f.alive) continue;
      const b = this.bucketOf(f.x, f.y);
      this.bucketNext[i] = this.bucketHead[b]!;
      this.bucketHead[b] = i;
      this.bucketCount[b] = this.bucketCount[b]! + 1;
    }
  }

  private bucketOf(x: number, y: number) {
    const size = this.perception;
    const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
    const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
    return r * this.bucketCols + c;
  }

  private stepFish(dt: number) {
    const { fish, sharks, pointer, width: W, height: H, time } = this;
    const R = this.perception;
    const R2 = R * R;
    const foreignSep = this.foreignSep;
    const size = this.perception;
    const cols = this.bucketCols;
    const rows = this.bucketRows;
    const head = this.bucketHead;
    const next = this.bucketNext;
    const cur = this.tmp;
    const calmDecay = Math.exp(-dt * 0.7);
    const contagion = Math.min(1, dt * 6);

    for (let i = 0; i < fish.length; i++) {
      const f = fish[i]!;
      if (!f.alive) continue;
      const sp = SPECIES[f.species]!;
      // Alarmed fish want more room: the school flashes apart around a
      // shark and closes back up once the threat fades.
      const spread = 1 + 1.8 * f.alarm;
      const sepX = this.sepX[f.species]! * spread;
      const sepY = this.sepY[f.species]! * spread;

      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let ax = 0;
      let ay = 0;
      let sx = 0;
      let sy = 0;
      let avx = 0;
      let avy = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      let neighbourAlarm = 0;

      const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
      const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
          let j = head[r * cols + c]!;
          while (j !== -1) {
            if (j !== i) {
              const o = fish[j]!;
              const dx = o.x - f.x;
              const dy = o.y - f.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < R2 && d2 > 1e-6) {
                const d = Math.sqrt(d2);
                // Blind zone directly behind the fish.
                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                  // Elliptical personal space: wide along x, tight along y.
                  const qx = dx / sepX;
                  const qy = dy / sepY;
                  const q2 = qx * qx + qy * qy;
                  if (q2 < 1) {
                    const q = Math.sqrt(q2) || 1e-3;
                    const k = (1 - q) / q;
                    sx -= qx * k;
                    sy -= qy * k;
                  }
                  if (o.species === f.species) {
                    avx += o.vx;
                    avy += o.vy;
                    cx += dx;
                    cy += dy;
                    n++;
                  } else if (d < foreignSep) {
                    // Different species keep their own schools.
                    const k = ((1 - d / foreignSep) / d) * 0.6;
                    sx -= dx * k;
                    sy -= dy * k;
                  }
                  if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
                }
              }
            }
            j = next[j]!;
          }
        }
      }

      ax += sx * FISH_SEPARATION_K;
      ay += sy * FISH_SEPARATION_K;
      if (n > 0) {
        const alignK = FISH_ALIGN_K * sp.align;
        const cohesionK = FISH_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
        ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
        ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
        if (sp.mill > 0) {
          // Circle the local centre: the school spins into a bait ball.
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
          ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
        }
      }

      // Predators. Distance is measured to the nearest point along the front
      // half of the shark, so fish also give the flanks a wide berth.
      let fear = 0;
      for (const sh of sharks) {
        const fearR = sh.length * 0.6 + 60;
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (let k = 0; k <= 12; k += 3) {
          const nx = sh.nodes[k * 2]!;
          const ny = sh.nodes[k * 2 + 1]!;
          const d2 = (f.x - nx) ** 2 + (f.y - ny) ** 2;
          if (d2 < best) {
            best = d2;
            bx = nx;
            by = ny;
          }
        }
        const d = Math.sqrt(best);
        if (d >= fearR || d < 1e-3) continue;
        let w = 1 - d / fearR;
        w *= w;
        const awayX = (f.x - bx) / d;
        const awayY = (f.y - by) / d;
        // Fountain effect: break to whichever side of the shark's path you're on.
        const shx = Math.cos(sh.heading);
        const shy = Math.sin(sh.heading);
        const side = shx * (f.y - sh.nodes[1]!) - shy * (f.x - sh.nodes[0]!) >= 0 ? 1 : -1;
        ax += (awayX * 0.7 - shy * side * 0.9) * FISH_FLEE_K * w;
        ay += (awayY * 0.7 + shx * side * 0.9) * FISH_FLEE_K * w;
        fear = Math.max(fear, Math.sqrt(w));
      }

      if (pointer.active) {
        const pr = 130;
        const dx = f.x - pointer.x;
        const dy = f.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < pr && d > 1e-3) {
          const w = (1 - d / pr) ** 2;
          ax += (dx / d) * FISH_FLEE_K * w;
          ay += (dy / d) * FISH_FLEE_K * w;
          fear = Math.max(fear, Math.sqrt(w) * 0.8);
        }
      }

      // Alarm: direct threat sets it, neighbours pass it along (slightly
      // weaker each hop), and it fades on its own.
      let alarm = Math.max(f.alarm * calmDecay, fear);
      const relayed = neighbourAlarm * 0.86;
      if (relayed > alarm) alarm += (relayed - alarm) * contagion;
      f.alarm = alarm;

      // Soft walls.
      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > W - m) ax -= (f.x - (W - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > H - m) ay -= (f.y - (H - m)) * 7;

      // Out from under the tiles and panels, by the nearest side.
      for (const b of this.boxes) {
        if (f.x <= b.x0 - 6 || f.x >= b.x1 + 6 || f.y <= b.y0 - 6 || f.y >= b.y1 + 6) continue;
        const l = f.x - b.x0 + 6;
        const r = b.x1 + 6 - f.x;
        const t = f.y - b.y0 + 6;
        const d = b.y1 + 6 - f.y;
        const near = Math.min(l, r, t, d);
        const k = 40 + 7 * Math.min(near, 50);
        if (near === l) ax -= k;
        else if (near === r) ax += k;
        else if (near === t) ay -= k;
        else ay += k;
      }

      // Ambient current and a little individual restlessness.
      current(f.x, f.y, time, cur);
      ax += cur.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay += cur.y * 0.5 + (Math.random() - 0.5) * sp.jitter;
      // Swim level, except when bolting from danger.
      ay -= f.vy * sp.verticalDrag * (1 - 0.7 * f.alarm);

      // Relax toward a preferred speed that rises with panic.
      const preferred = sp.cruise * (1 + 1.3 * f.alarm);
      ax += (preferred - speed) * hx * 1.6;
      ay += (preferred - speed) * hy * 1.6;

      const before = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      if (s > maxSpeed) {
        f.vx *= maxSpeed / s;
        f.vy *= maxSpeed / s;
      } else if (s < sp.minSpeed && s > 1e-3) {
        f.vx *= sp.minSpeed / s;
        f.vy *= sp.minSpeed / s;
      }
      f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      f.phase += dt * (7 + Math.hypot(f.vx, f.vy) * 0.12);
      f.x = clamp(f.x + f.vx * dt, -60, W + 60);
      f.y = clamp(f.y + f.vy * dt, -60, H + 60);
    }
  }

  private stepSharks(dt: number) {
    const { width: W, height: H, time } = this;
    const cxW = W / 2;
    const cyW = H / 2;
    const unit = this.unit();

    for (const sh of this.sharks) {
      const mood = MOODS[sh.mood];
      sh.depth += (mood.depth - sh.depth) * Math.min(1, dt * 0.6);
      // Seen from above, a shark that comes up grows and one that goes down shrinks.
      const L = (sh.length = unit * sh.size * (0.8 + 0.3 * sh.depth));
      const nodes = sh.nodes;
      const hx = nodes[0]!;
      const hy = nodes[1]!;

      // Only an agent at work gets hungry: the others swim past the fish.
      sh.hunger = sh.mood === "hunt" ? Math.min(1, sh.hunger + dt * 0.12) : Math.min(sh.hunger, 0.2);

      // Momentum.
      let dx = Math.cos(sh.heading);
      let dy = Math.sin(sh.heading);

      // Wander: a slowly drifting offset on a circle ahead of the snout. A shark whose agent needs
      // you hardly wanders: it keeps to its tile.
      sh.wander = clamp(sh.wander + (Math.random() - 0.5) * dt * 3.2, -1.1, 1.1);
      const wander = sh.mood === "surface" ? 0.12 : 0.45;
      dx += Math.cos(sh.heading + sh.wander) * wander;
      dy += Math.sin(sh.heading + sh.wander) * wander;

      // Hunt.
      if (sh.mood !== "hunt" || sh.leaving) sh.target = null;
      else if (time >= sh.retargetAt) {
        sh.target = this.findPrey(sh);
        sh.retargetAt = time + 0.45;
      }
      const t = sh.target;
      let tile: Box | undefined;
      /** Far from the tile it should be circling, or under a tile: it hurries, as fast as it hunts. */
      let hurry = false;
      let hunting = false;
      let closing = 0;
      if (sh.leaving) {
        // Out by the nearer side.
        dx += (hx < cxW ? -1 : 1) * 2.5;
      } else if (t && t.alive && sh.hunger > 0.3) {
        // Pursuit: aim at where the fish is about to be.
        const tx = t.x + t.vx * 0.35 - hx;
        const ty = t.y + t.vy * 0.35 - hy;
        const d = Math.hypot(tx, ty) || 1;
        const w = 1.4 + 2.6 * sh.hunger;
        dx += (tx / d) * w;
        dy += (ty / d) * w;
        hunting = true;
        closing = clamp(1 - d / (L * 0.9), 0, 1);
      } else if (sh.mood === "surface" && (tile = this.tileBox.get(sh.key))) {
        // It needs you: it circles its agent's tile, just outside it, where you would look.
        const bx = (tile.x0 + tile.x1) / 2;
        const by = (tile.y0 + tile.y1) / 2;
        const rx = (tile.x1 - tile.x0) / 2 + L * 0.3;
        const ry = (tile.y1 - tile.y0) / 2 + L * 0.3;
        // Aim a radian ahead of where it is on the ring, so it follows the ring wherever it is (a
        // nearer aim has it loop beside the ring instead).
        const at = Math.atan2((hy - by) / ry, (hx - bx) / rx) + sh.orbitDir;
        hurry = Math.hypot(Math.max(tile.x0 - hx, 0, hx - tile.x1), Math.max(tile.y0 - hy, 0, hy - tile.y1)) > L * 0.6;
        const gx = clamp(bx + Math.cos(at) * rx, L * 0.15, W - L * 0.15);
        const gy = clamp(by + Math.sin(at) * ry, L * 0.15, H - L * 0.15);
        const d = Math.hypot(gx - hx, gy - hy) || 1;
        dx += ((gx - hx) / d) * 2.4;
        dy += ((gy - hy) / d) * 2.4;
      } else {
        // Roam the open water: swim to a point between the tiles, then pick another. A resting
        // shark keeps to the bottom.
        const rest = sh.mood === "rest";
        const g = sh.goal;
        if (!g || time > sh.goalAt || Math.hypot(g.x - hx, g.y - hy) < L * 0.4) {
          const here = { x: hx, y: hy, heading: sh.heading, reach: L };
          sh.goal = rest ? this.openPoint(0.72, 0.92, here) : this.openPoint(0.08, 0.92, here);
          sh.goalAt = time + rand(8, 16);
        }
        const to = sh.goal!;
        const d = Math.hypot(to.x - hx, to.y - hy) || 1;
        const w = rest ? 0.8 : 1.1;
        dx += ((to.x - hx) / d) * w;
        dy += ((to.y - hy) / d) * w;
      }

      // Turn away before the snout goes under a tile or a panel: looking well ahead, since a long
      // shark turns wide. A shark circling its own tile keeps outside it by its circle already.
      if (!sh.leaving) {
        const ax = hx + Math.cos(sh.heading) * L * 0.6;
        const ay = hy + Math.sin(sh.heading) * L * 0.6;
        const pad = L * 0.12;
        for (const b of this.boxes) {
          if (b === tile) continue;
          if (hx > b.x0 && hx < b.x1 && hy > b.y0 && hy < b.y1) {
            // Already under it (a tile was put down over it): out by the nearest side, quickly.
            hurry = true;
            const l = hx - b.x0;
            const r = b.x1 - hx;
            const t = hy - b.y0;
            const d = b.y1 - hy;
            const near = Math.min(l, r, t, d);
            if (near === l) dx -= 3;
            else if (near === r) dx += 3;
            else if (near === t) dy -= 3;
            else dy += 3;
            continue;
          }
          if (ax <= b.x0 - pad || ax >= b.x1 + pad || ay <= b.y0 - pad || ay >= b.y1 + pad) continue;
          const ex = (ax - (b.x0 + b.x1) / 2) / ((b.x1 - b.x0) / 2 + pad);
          const ey = (ay - (b.y0 + b.y1) / 2) / ((b.y1 - b.y0) / 2 + pad);
          const e = Math.hypot(ex, ey) || 1e-3;
          const w = hunting ? 1.8 : 3;
          dx += (ex / e) * w;
          dy += (ey / e) * w;
        }
      }

      // Give other sharks room. A shark whose agent needs you hardly gives way: the others do,
      // so it keeps to its tile.
      const room = sh.mood === "surface" ? 0.6 : 3;
      for (const other of this.sharks) {
        if (other === sh) continue;
        for (let k = 0; k < SHARK_NODES; k += 4) {
          const ox = hx - other.nodes[k * 2]!;
          const oy = hy - other.nodes[k * 2 + 1]!;
          const d = Math.hypot(ox, oy);
          const range = (L + other.length) * 0.45;
          if (d < range && d > 1e-3) {
            const w = (1 - d / range) * room;
            dx += (ox / d) * w;
            dy += (oy / d) * w;
          }
        }
      }

      // Turn back once the snout leaves the frame, so bodies dip off-screen
      // now and then but the sharks never wander away for good.
      const over = Math.max(-hx, hx - W, -hy, hy - H);
      if (!sh.leaving && over > -L * 0.05) {
        const w = clamp((over + L * 0.05) / (L * 0.35), 0, 1) * 3.5;
        const toX = cxW - hx;
        const toY = cyW - hy;
        const d = Math.hypot(toX, toY) || 1;
        dx += (toX / d) * w;
        dy += (toY / d) * w;
      }

      const desired = Math.atan2(dy, dx);
      // Sharks can't pivot on the spot: the turning circle grows with speed, and one in no hurry
      // turns in a wide, lazy curve, half its length across, never doubling back on itself.
      const agility = Math.min(hunting ? 1.7 + closing : 0.8, sh.speed / (L * (hunting || hurry ? 0.22 : 0.5)));
      const maxTurn = agility * dt;
      const turned = clamp(angleDiff(sh.heading, desired), -maxTurn, maxTurn);
      sh.heading += turned;
      sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3);

      const cruise = 30 + L * 0.04;
      const targetSpeed = hunting ? cruise * (1.45 + closing * 1.5) : cruise * (sh.leaving ? 1.3 : hurry ? 3 : mood.pace);
      sh.speed += (targetSpeed - sh.speed) * Math.min(1, dt * 1.1);
      sh.phase += dt * (2 + sh.speed / 24);

      nodes[0] = nodes[0]! + Math.cos(sh.heading) * sh.speed * dt;
      nodes[1] = nodes[1]! + Math.sin(sh.heading) * sh.speed * dt;

      // Follow-the-leader spine, with a stiffness limit per joint so the
      // body bends into a C at most and never folds back on itself.
      const seg = L / (SHARK_NODES - 1);
      const maxBend = 0.16;
      let prevAngle = sh.heading + Math.PI;
      for (let k = 1; k < SHARK_NODES; k++) {
        const px = nodes[(k - 1) * 2]!;
        const py = nodes[(k - 1) * 2 + 1]!;
        let angle = Math.atan2(nodes[k * 2 + 1]! - py, nodes[k * 2]! - px);
        angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
        nodes[k * 2] = px + Math.cos(angle) * seg;
        nodes[k * 2 + 1] = py + Math.sin(angle) * seg;
        prevAngle = angle;
      }

      // Feed.
      if (hunting && sh.hunger > 0.15) {
        const mouthR = L * 0.05 + 8;
        const mx = nodes[0]!;
        const my = nodes[1]!;
        for (const f of this.fish) {
          if (!f.alive) continue;
          if ((f.x - mx) ** 2 + (f.y - my) ** 2 < mouthR * mouthR) {
            f.alive = false;
            f.respawnAt = time + rand(3, 8);
            sh.hunger = Math.max(0, sh.hunger - 0.16);
            this.events.push({ kind: "eat", x: f.x, y: f.y });
          }
        }
      }
    }

    // A shark that has swum off is gone once all of it, snout to tail, is out of sight.
    const gone = (sh: Shark) => {
      const n = sh.nodes;
      const t = (SHARK_NODES - 1) * 2;
      return Math.min(n[0]!, n[t]!) > W + 20 || Math.max(n[0]!, n[t]!) < -20 || Math.min(n[1]!, n[t + 1]!) > H + 20 || Math.max(n[1]!, n[t + 1]!) < -20;
    };
    if (this.sharks.some((sh) => sh.leaving && gone(sh))) this.sharks = this.sharks.filter((sh) => !(sh.leaving && gone(sh)));
  }

  /**
   * Pick prey in the shark's forward cone, preferring close fish in sparse
   * buckets (stragglers) over fish buried in a dense school.
   */
  private findPrey(sh: Shark): Fish | null {
    const range = sh.length * 0.9 + 160;
    const hx = sh.nodes[0]!;
    const hy = sh.nodes[1]!;
    const fx = Math.cos(sh.heading);
    const fy = Math.sin(sh.heading);
    let best: Fish | null = null;
    let bestScore = Infinity;
    let currentScore = Infinity;

    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - hx;
      const dy = f.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1e-3) continue;
      const cos = (dx * fx + dy * fy) / d;
      if (cos < 0.2) continue;
      const crowd = this.bucketCount[this.bucketOf(f.x, f.y)]!;
      const score = d * (1 + (1 - cos) * 0.8) * (1 + crowd * 0.07);
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
      if (f === sh.target) currentScore = score;
    }
    // Stick with the current target unless something is clearly better.
    if (sh.target && currentScore < bestScore * 1.3) return sh.target;
    return best;
  }

  private respawn() {
    const { time, width: W, height: H } = this;
    const due: Fish[] = [];
    for (const f of this.fish) if (!f.alive && f.respawnAt <= time) due.push(f);
    if (due.length === 0) return;
    if (due.length < 6 && time - this.lastSpawn < 9) return;
    this.lastSpawn = time;

    // A new school swims in from a random edge.
    const side = randInt(0, 3);
    const along = rand(0.15, 0.85);
    const x = side === 0 ? -20 : side === 1 ? W + 20 : along * W;
    const y = side === 2 ? -20 : side === 3 ? H + 20 : along * H;
    const inward = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.5, 0.5);
    const species = pickSpecies();
    const sp = SPECIES[species]!;
    const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    for (const f of due.slice(0, sp.schoolSize[1])) {
      f.alive = true;
      f.species = species;
      f.alarm = 0;
      f.turn = 0;
      f.millDir = millDir;
      f.x = x + rand(-1, 1) * this.perception;
      f.y = y + rand(-1, 1) * this.perception;
      f.vx = Math.cos(inward) * sp.cruise * 1.4;
      f.vy = Math.sin(inward) * sp.cruise * 1.4;
    }
  }
}
