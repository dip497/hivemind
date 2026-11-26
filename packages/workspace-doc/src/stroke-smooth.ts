/** A pen stroke as the outline of a smooth line that thins where the hand moved fast. */
import type { ShapeDash } from "./shapes";

type Pair = readonly [number, number];

function averaged(points: ReadonlyArray<Pair>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const last = points.length - 1;
  for (let i = 0; i <= last; i++) {
    const p = points[i]!;
    if (i === 0 || i === last) { out.push([p[0], p[1]]); continue; }
    const [a, b] = [points[i - 1]!, points[i + 1]!];
    out.push([(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4]);
  }
  return out;
}

function cornersCut(points: ReadonlyArray<Pair>): Array<[number, number]> {
  const last = points.length - 1;
  if (last < 2) return points.map((p) => [p[0], p[1]]);
  const out: Array<[number, number]> = [[points[0]![0], points[0]![1]]];
  for (let i = 0; i < last; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push([points[last]![0], points[last]![1]]);
  return out;
}

function roundCap(out: Array<[number, number]>, at: Pair, half: number, from: number): void {
  for (let step = 1; step < 6; step++) {
    const turn = from - (Math.PI * step) / 6;
    out.push([at[0] + Math.cos(turn) * half, at[1] + Math.sin(turn) * half]);
  }
}

export function smoothStroke(points: ReadonlyArray<readonly [number, number]>, width: number): Array<[number, number]> {
  if (points.length === 0) return [];
  const half = Math.max(0.25, width / 2);
  if (points.length === 1) {
    const dot: Array<[number, number]> = [];
    for (let step = 0; step < 12; step++) {
      const turn = (Math.PI * step) / 6;
      dot.push([points[0]![0] + Math.cos(turn) * half, points[0]![1] + Math.sin(turn) * half]);
    }
    return dot;
  }
  // The pace is read from the points as drawn, before any are added between them.
  const pace: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const [a, b] = [points[Math.max(0, i - 1)]!, points[Math.min(points.length - 1, i + 1)]!];
    const gap = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    pace.push(Math.max(0.55, 1 / (1 + gap / (width * 14))));
  }
  let line = averaged(points);
  let thick = pace;
  const rounds = points.length > 600 ? 0 : points.length > 200 ? 1 : 2;
  for (let round = 0; round < rounds; round++) {
    const next = cornersCut(line);
    if (next.length !== line.length) {
      const spread: number[] = [thick[0]!];
      for (let i = 0; i < thick.length - 1; i++) {
        spread.push(thick[i]! * 0.75 + thick[i + 1]! * 0.25, thick[i]! * 0.25 + thick[i + 1]! * 0.75);
      }
      spread.push(thick[thick.length - 1]!);
      thick = spread;
    }
    line = next;
  }
  const last = line.length - 1;
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  let [nx, ny] = [0, 1];
  let [firstTurn, lastTurn] = [0, 0];
  for (let i = 0; i <= last; i++) {
    const [a, b] = [line[Math.max(0, i - 1)]!, line[Math.min(last, i + 1)]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) [nx, ny] = [-dy / length, dx / length];
    const turn = Math.atan2(ny, nx);
    if (i === 0) firstTurn = turn;
    lastTurn = turn;
    const ends = Math.min(1, 0.7 + 0.3 * Math.min(i, last - i) / 4);
    const reach = half * (thick[i] ?? 1) * ends;
    const p = line[i]!;
    left.push([p[0] + nx * reach, p[1] + ny * reach]);
    right.push([p[0] - nx * reach, p[1] - ny * reach]);
  }
  const startHalf = Math.hypot(left[0]![0] - line[0]![0], left[0]![1] - line[0]![1]);
  const endHalf = Math.hypot(left[last]![0] - line[last]![0], left[last]![1] - line[last]![1]);
  const out: Array<[number, number]> = left;
  // Each cap sweeps from one side to the other round the outside of its end.
  roundCap(out, line[last]!, endHalf, lastTurn);
  for (let i = last; i >= 0; i--) out.push(right[i]!);
  roundCap(out, line[0]!, startHalf, firstTurn + Math.PI);
  return out;
}

export function dashPattern(dash: ShapeDash | undefined, px: number): number[] {
  if (dash === "dashed") return [px * 4, px * 3];
  if (dash === "dotted") return [0.01, px * 2.6];
  return [];
}
