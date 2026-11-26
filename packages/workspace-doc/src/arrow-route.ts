/**
 * The line an arrow takes between two boxes: straight, a curve leaving each side at a right angle,
 * or a right-angle route that walks round the boxes in its way.
 */
import type { ArrowRoute, Side } from "./shapes";
import { facingSides, sidePoint, type Point, type Rect } from "./drawing";

export interface ArrowLine {
  /** The SVG path. */
  path: string;
  /** The corners of the line (a curve: points along it), first on the start box, last on the end box. */
  points: Point[];
  /** Half way along the line, where the label sits. */
  mid: Point;
  /** Radians: the way the line travels as it arrives. */
  endAngle: number;
  /** Radians: the way a head at the start points, back at the start box. */
  startAngle: number;
}

const STUB = 16;
const CLEARANCE = 12;
const CORNER = 8;
const BEND_COST = 24;
const MOST_NODES_OPENED = 400;

const OUT: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const HEADING: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };
const STEP_X = [1, 0, -1, 0];
const STEP_Y = [0, 1, 0, -1];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round = (n: number): number => Math.round(n * 100) / 100;
const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (a: Point, b: Point): number => Math.atan2(b.y - a.y, b.x - a.x);

function sideNearest(at: readonly [number, number]): Side {
  const [fx, fy] = [clamp01(at[0]), clamp01(at[1])];
  const gaps: Array<[Side, number]> = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
  return gaps.reduce((best, g) => (g[1] < best[1] ? g : best))[0];
}

function endOn(box: Rect, facing: Side, at?: readonly [number, number]): { point: Point; side: Side } {
  if (!at) return { point: sidePoint(box, facing), side: facing };
  return { point: { x: box.x + clamp01(at[0]) * box.w, y: box.y + clamp01(at[1]) * box.h }, side: sideNearest(at) };
}

function halfWay(points: readonly Point[]): Point {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = distance(a, b);
    if (d > 0 && left <= d) return { x: a.x + ((b.x - a.x) * left) / d, y: a.y + ((b.y - a.y) * left) / d };
    left -= d;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

function withoutSpareCorners(points: readonly Point[]): Point[] {
  const kept: Point[] = [];
  for (const p of points) {
    const last = kept[kept.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = kept[kept.length - 2];
    if (last && before && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) kept.pop();
    kept.push(p);
  }
  return kept;
}

function roundedPath(points: readonly Point[]): string {
  const first = points[0]!;
  let d = `M${round(first.x)},${round(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1]!;
    const corner = points[i]!;
    const after = points[i + 1]!;
    const lengthIn = distance(before, corner);
    const lengthOut = distance(corner, after);
    const r = Math.min(CORNER, lengthIn / 2, lengthOut / 2);
    if (r <= 0) continue;
    const enter = { x: corner.x + ((before.x - corner.x) * r) / lengthIn, y: corner.y + ((before.y - corner.y) * r) / lengthIn };
    const leave = { x: corner.x + ((after.x - corner.x) * r) / lengthOut, y: corner.y + ((after.y - corner.y) * r) / lengthOut };
    d += ` L${round(enter.x)},${round(enter.y)} Q${round(corner.x)},${round(corner.y)} ${round(leave.x)},${round(leave.y)}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L${round(last.x)},${round(last.y)}`;
}

const sortedOnce = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

function crosses(a: Point, b: Point, blocks: readonly Rect[]): boolean {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  for (const r of blocks) {
    if (a.y === b.y ? a.y > r.y && a.y < r.y + r.h && right > r.x && left < r.x + r.w
      : a.x > r.x && a.x < r.x + r.w && bottom > r.y && top < r.y + r.h) return true;
  }
  return false;
}

/** The cheapest right-angle walk from `start` to `goal` along the blocks' edges, or null. */
function walkRound(start: Point, goal: Point, startHeading: number, endHeading: number, blocks: readonly Rect[]): Point[] | null {
  const xs = sortedOnce([start.x, goal.x, (start.x + goal.x) / 2, ...blocks.flatMap((r) => [r.x, r.x + r.w])]);
  const ys = sortedOnce([start.y, goal.y, (start.y + goal.y) / 2, ...blocks.flatMap((r) => [r.y, r.y + r.h])]);
  const across = xs.length;
  const goalX = xs.indexOf(goal.x);
  const goalY = ys.indexOf(goal.y);
  const keyOf = (ix: number, iy: number, heading: number): number => (iy * across + ix) * 4 + heading;
  const ahead = (ix: number, iy: number): number => Math.abs(xs[ix]! - goal.x) + Math.abs(ys[iy]! - goal.y);
  const cost = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const startX = xs.indexOf(start.x);
  const startY = ys.indexOf(start.y);
  const open = [{ key: keyOf(startX, startY, startHeading), ix: startX, iy: startY, heading: startHeading, spent: 0, guess: ahead(startX, startY) }];
  cost.set(open[0]!.key, 0);
  let opened = 0;
  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.guess < open[best]!.guess) best = i;
    const here = open[best]!;
    open[best] = open[open.length - 1]!;
    open.pop();
    if (here.spent > (cost.get(here.key) ?? Infinity)) continue;
    if (here.ix === goalX && here.iy === goalY) {
      const walked: Point[] = [];
      for (let key: number | undefined = here.key; key !== undefined; key = cameFrom.get(key)) {
        const cell = (key - (key % 4)) / 4;
        walked.push({ x: xs[cell % across]!, y: ys[Math.floor(cell / across)]! });
      }
      return walked.reverse();
    }
    if (++opened > MOST_NODES_OPENED) return null;
    const from = { x: xs[here.ix]!, y: ys[here.iy]! };
    for (let heading = 0; heading < 4; heading++) {
      if ((heading + 2) % 4 === here.heading) continue;
      const ix = here.ix + STEP_X[heading]!;
      const iy = here.iy + STEP_Y[heading]!;
      if (ix < 0 || iy < 0 || ix >= across || iy >= ys.length) continue;
      const to = { x: xs[ix]!, y: ys[iy]! };
      if (crosses(from, to, blocks)) continue;
      let spent = here.spent + Math.abs(to.x - from.x) + Math.abs(to.y - from.y) + (heading === here.heading ? 0 : BEND_COST);
      if (ix === goalX && iy === goalY && heading !== endHeading) spent += BEND_COST;
      const key = keyOf(ix, iy, heading);
      if (spent >= (cost.get(key) ?? Infinity)) continue;
      cost.set(key, spent);
      cameFrom.set(key, here.key);
      open.push({ key, ix, iy, heading, spent, guess: spent + ahead(ix, iy) });
    }
  }
  return null;
}

function threeSegments(start: Point, goal: Point, startSide: Side): Point[] {
  if (startSide === "left" || startSide === "right") {
    const x = (start.x + goal.x) / 2;
    return [start, { x, y: start.y }, { x, y: goal.y }, goal];
  }
  const y = (start.y + goal.y) / 2;
  return [start, { x: start.x, y }, { x: goal.x, y }, goal];
}

const grown = (r: Rect): Rect => ({ x: r.x - CLEARANCE, y: r.y - CLEARANCE, w: r.w + CLEARANCE * 2, h: r.h + CLEARANCE * 2 });

export function routeArrow(
  from: Rect,
  to: Rect,
  route: ArrowRoute | undefined,
  avoid: readonly Rect[],
  ends?: { fromAt?: [number, number]; toAt?: [number, number] },
): ArrowLine {
  const [fromFacing, toFacing] = facingSides(from, to);
  const start = endOn(from, fromFacing, ends?.fromAt);
  const end = endOn(to, toFacing, ends?.toAt);
  const a = start.point;
  const b = end.point;
  const outA = OUT[start.side];
  const outB = OUT[end.side];

  if (route !== "straight" && route !== "elbow") {
    const reach = Math.min(200, Math.max(30, distance(a, b) * 0.4));
    const c1 = { x: a.x + outA.x * reach, y: a.y + outA.y * reach };
    const c2 = { x: b.x + outB.x * reach, y: b.y + outB.y * reach };
    const points: Point[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const u = 1 - t;
      points.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
    return {
      path: `M${round(a.x)},${round(a.y)} C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(b.x)},${round(b.y)}`,
      points,
      mid: halfWay(points),
      endAngle: angle(c2, b),
      startAngle: angle(c1, a),
    };
  }

  if (route === "elbow") {
    const stubA = { x: a.x + outA.x * STUB, y: a.y + outA.y * STUB };
    const stubB = { x: b.x + outB.x * STUB, y: b.y + outB.y * STUB };
    const blocks = [from, to, ...avoid].map(grown);
    const between = walkRound(stubA, stubB, HEADING[start.side], (HEADING[end.side] + 2) % 4, blocks) ?? threeSegments(stubA, stubB, start.side);
    const points = withoutSpareCorners([a, ...between, b]);
    return {
      path: roundedPath(points),
      points,
      mid: halfWay(points),
      endAngle: angle(points[points.length - 2] ?? a, b),
      startAngle: angle(points[1] ?? b, a),
    };
  }

  return {
    path: `M${round(a.x)},${round(a.y)} L${round(b.x)},${round(b.y)}`,
    points: [a, b],
    mid: halfWay([a, b]),
    endAngle: angle(a, b),
    startAngle: angle(b, a),
  };
}
