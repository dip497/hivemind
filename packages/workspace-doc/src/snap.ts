/** A box being moved lines up with the edges and middles of the boxes near it. */
import type { Rect } from "./drawing";

/** A guide: axis "x" is an upright line at x = at, running from..to in y; axis "y" lies flat. */
export interface SnapLine { axis: "x" | "y"; at: number; from: number; to: number }

const NONE: { dx: number; dy: number; lines: SnapLine[] } = { dx: 0, dy: 0, lines: [] };

export function snapMove(moving: Rect, others: readonly Rect[], within: number): { dx: number; dy: number; lines: SnapLine[] } {
  if (others.length === 0 || within <= 0) return NONE;
  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let [dx, dy] = [0, 0];
  let [nearX, nearY] = [within, within];
  let [foundX, foundY] = [false, false];
  for (const o of others) {
    for (let j = 0; j < 3; j++) {
      const ox = o.x + (o.w * j) / 2;
      const oy = o.y + (o.h * j) / 2;
      for (let i = 0; i < 3; i++) {
        const gapX = ox - mx[i]!;
        if (Math.abs(gapX) < nearX || (!foundX && Math.abs(gapX) <= nearX)) { nearX = Math.abs(gapX); dx = gapX; foundX = true; }
        const gapY = oy - my[i]!;
        if (Math.abs(gapY) < nearY || (!foundY && Math.abs(gapY) <= nearY)) { nearY = Math.abs(gapY); dy = gapY; foundY = true; }
      }
    }
  }
  if (!foundX && !foundY) return NONE;
  if (!foundX) dx = 0;
  if (!foundY) dy = 0;
  const top = moving.y + dy;
  const left = moving.x + dx;
  const upright: Array<SnapLine | undefined> = [undefined, undefined, undefined];
  const flat: Array<SnapLine | undefined> = [undefined, undefined, undefined];
  for (const o of others) {
    for (let j = 0; j < 3; j++) {
      const ox = o.x + (o.w * j) / 2;
      const oy = o.y + (o.h * j) / 2;
      for (let i = 0; i < 3; i++) {
        if (foundX && Math.abs(ox - (mx[i]! + dx)) < 0.01) {
          const line = (upright[i] ??= { axis: "x", at: ox, from: top, to: top + moving.h });
          line.from = Math.min(line.from, o.y);
          line.to = Math.max(line.to, o.y + o.h);
        }
        if (foundY && Math.abs(oy - (my[i]! + dy)) < 0.01) {
          const line = (flat[i] ??= { axis: "y", at: oy, from: left, to: left + moving.w });
          line.from = Math.min(line.from, o.x);
          line.to = Math.max(line.to, o.x + o.w);
        }
      }
    }
  }
  const lines: SnapLine[] = [];
  for (const line of upright) if (line) lines.push(line);
  for (const line of flat) if (line) lines.push(line);
  return { dx, dy, lines };
}
