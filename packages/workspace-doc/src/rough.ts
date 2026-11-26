/** A shape's outline as a hand would draw it: the same wobble every time, from the shape's id. */
import { shapeOutline } from "./drawing";
import type { ShapeObject } from "./shapes";

type Pair = readonly [number, number];

function seededRandom(text: string): () => number {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const short = (n: number): string => (Math.round(n * 100) / 100).toString();

function cornersOf(o: ShapeObject): Pair[] | null {
  const { w, h } = o;
  switch (o.form) {
    case "rect": return [[0, 0], [w, 0], [w, h], [0, h]];
    case "diamond": return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
    case "triangle": return [[w / 2, 0], [w, h], [0, h]];
    case "hexagon": return [[w / 4, 0], [(w * 3) / 4, 0], [w, h / 2], [(w * 3) / 4, h], [w / 4, h], [0, h / 2]];
    case "parallelogram": return [[w / 5, 0], [w, 0], [(w * 4) / 5, h], [0, h]];
    case "star": {
      const out: Pair[] = [];
      for (let i = 0; i < 10; i++) {
        const turn = -Math.PI / 2 + (Math.PI * i) / 5;
        const reach = i % 2 ? 0.4 : 1;
        out.push([w / 2 + (Math.cos(turn) * reach * w) / 2, h / 2 + (Math.sin(turn) * reach * h) / 2]);
      }
      return out;
    }
    default: return null;
  }
}

function edge(a: Pair, b: Pair, random: () => number): string {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.01) return "";
  const off = Math.min(2.4, 0.6 + length / 80);
  const jitter = () => (random() - 0.5) * 2 * off;
  const bow = (random() - 0.5) * Math.min(6, length * 0.05);
  const [nx, ny] = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  const along = 0.4 + random() * 0.2;
  const mx = a[0] + (b[0] - a[0]) * along + nx * bow;
  const my = a[1] + (b[1] - a[1]) * along + ny * bow;
  return `M${short(a[0] + jitter())} ${short(a[1] + jitter())}Q${short(mx)} ${short(my)} ${short(b[0] + jitter())} ${short(b[1] + jitter())}`;
}

function loop(w: number, h: number, random: () => number): string {
  const steps = 14;
  const wobble = Math.min(0.05, 2.5 / Math.max(8, Math.min(w, h)));
  const start = random() * Math.PI * 2;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < steps; i++) {
    const turn = start + (Math.PI * 2 * i) / steps;
    const reach = 1 + (random() - 0.5) * 2 * wobble;
    ring.push([w / 2 + (Math.cos(turn) * reach * w) / 2, h / 2 + (Math.sin(turn) * reach * h) / 2]);
  }
  const between = (i: number): [number, number] => {
    const [a, b] = [ring[i % steps]!, ring[(i + 1) % steps]!];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const first = between(0);
  let path = `M${short(first[0])} ${short(first[1])}`;
  for (let i = 1; i <= steps; i++) {
    const [corner, to] = [ring[i % steps]!, between(i)];
    path += `Q${short(corner[0])} ${short(corner[1])} ${short(to[0])} ${short(to[1])}`;
  }
  return path;
}

export function roughPath(o: ShapeObject): string {
  const random = seededRandom(o.id);
  if (o.form === "ellipse") return loop(o.w, o.h, random) + loop(o.w, o.h, random);
  const open = o.form === "line";
  const corners = open ? (o.points ?? []) : cornersOf(o);
  if (!corners || corners.length < 2) return shapeOutline(o);
  let path = "";
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < corners.length - (open ? 1 : 0); i++) {
      path += edge(corners[i]!, corners[(i + 1) % corners.length]!, random);
    }
  }
  return path;
}
