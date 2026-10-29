/**
 * Where a creature can go: the open water between the tiles and panels (the boxes), the room round
 * a point, and a goal in it. Every scene's creatures keep to the water by these, so a tile is
 * swum round the same way in each.
 */
import { angleDiff, rand } from "./math";
import type { Box } from "./scene";

/** Whether (x, y) is under a box, or within `pad` of one. */
export function covered(boxes: readonly Box[], x: number, y: number, pad: number) {
  for (const b of boxes) if (x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad) return true;
  return false;
}

/** How far a point is from the nearest box or the window's edge; less than 0 under a box, by how
 *  far it is in from that box's nearest side. */
export function roomAt(boxes: readonly Box[], width: number, height: number, x: number, y: number) {
  let room = Math.min(x, width - x, y, height - y);
  for (const b of boxes) {
    const inside = x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
    room = Math.min(room, inside ? -Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y) : Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1)));
  }
  return room;
}

/** A point in the open water between `top` and `bottom` (shares of the height), and one a creature
 *  at `from` can swim to without passing under a box if there is one: of a few tries, the one with
 *  the least of its way covered and, given the creature's heading, the least turn to it, at least
 *  `reach` away, so it swims on in long curves instead of doubling back. On a canvas too full for
 *  any try to be clear of the boxes, the try with the most room round it. */
export function openPoint(
  boxes: readonly Box[], width: number, height: number,
  top: number, bottom: number,
  from: { x: number; y: number; heading?: number; reach?: number },
) {
  const W = width;
  const H = height;
  let best = { x: W / 2, y: H / 2 };
  let bestCover = Infinity;
  let fallback = best;
  let fallbackRoom = -Infinity;
  const ahead = from.heading !== undefined;
  for (let i = 0; i < 16; i++) {
    const x = rand(W * 0.08, W * 0.92);
    const y = rand(H * top, H * bottom);
    if (covered(boxes, x, y, 60)) {
      const room = roomAt(boxes, W, H, x, y);
      if (room > fallbackRoom) {
        fallback = { x, y };
        fallbackRoom = room;
      }
      continue;
    }
    let cover = 0;
    for (let k = 1; k < 8; k++) if (covered(boxes, from.x + ((x - from.x) * k) / 8, from.y + ((y - from.y) * k) / 8, 30)) cover++;
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
