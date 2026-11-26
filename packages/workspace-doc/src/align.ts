/** Lining boxes up with each other, and spreading them evenly: where each one goes. */
import type { Point, Rect } from "./drawing";

export type AlignHow = "left" | "centre" | "right" | "top" | "middle" | "bottom" | "spread-across" | "spread-down";

type Named = Rect & { id: string };

function spread(rects: ReadonlyArray<Named>, across: boolean): Map<string, Point> {
  const out = new Map<string, Point>();
  if (rects.length < 3) return out;
  const start = (r: Rect): number => (across ? r.x : r.y);
  const length = (r: Rect): number => (across ? r.w : r.h);
  const sorted = [...rects].sort((a, b) => start(a) - start(b));
  const first = sorted[0]!;
  const end = Math.max(...sorted.map((r) => start(r) + length(r)));
  const taken = sorted.reduce((sum, r) => sum + length(r), 0);
  const gap = (end - start(first) - taken) / (sorted.length - 1);
  let at = start(first);
  for (const r of sorted) {
    out.set(r.id, across ? { x: at, y: r.y } : { x: r.x, y: at });
    at += length(r) + gap;
  }
  return out;
}

/** Where each box goes to line up as `how` says; the ones already there are left out. */
export function alignRects(rects: ReadonlyArray<Named>, how: AlignHow): Map<string, Point> {
  const moved = how === "spread-across" || how === "spread-down" ? spread(rects, how === "spread-across") : new Map<string, Point>();
  if (rects.length >= 2 && how !== "spread-across" && how !== "spread-down") {
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.w));
    const top = Math.min(...rects.map((r) => r.y));
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    for (const r of rects) {
      const x = how === "left" ? left : how === "right" ? right - r.w : how === "centre" ? (left + right - r.w) / 2 : r.x;
      const y = how === "top" ? top : how === "bottom" ? bottom - r.h : how === "middle" ? (top + bottom - r.h) / 2 : r.y;
      moved.set(r.id, { x, y });
    }
  }
  for (const r of rects) {
    const p = moved.get(r.id);
    if (p && p.x === r.x && p.y === r.y) moved.delete(r.id);
  }
  return moved;
}
