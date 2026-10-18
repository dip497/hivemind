/** Where widget cards nobody has moved yet sit: down the right edge of the screen, each below the one before it. */

export type Spot = { x: number; y: number };
export type Size = { w: number; h: number };

export const CARD_W = 240;
const EDGE = 16;
const TOP = 64;
const GAP = 12;
/** A card not yet drawn is taken to be this tall until its real height is known. */
const UNDRAWN_H = 48;

/**
 * One spot for each card in `ids`, in order, using each card's drawn size: each card goes below the
 * last, and a card that would run off the bottom starts a new column to the left of the last one.
 */
export function stackDownRightEdge(ids: readonly string[], sizes: Readonly<Record<string, Size>>, screen: Size): Record<string, Spot> {
  const spots: Record<string, Spot> = {};
  let right = screen.w - EDGE;
  let y = TOP;
  let columnW = 0;
  for (const id of ids) {
    const size = sizes[id] ?? { w: CARD_W, h: UNDRAWN_H };
    if (y > TOP && y + size.h > screen.h - EDGE) {
      right -= columnW + GAP;
      y = TOP;
      columnW = 0;
    }
    spots[id] = { x: Math.max(right - size.w, 0), y };
    y += size.h + GAP;
    columnW = Math.max(columnW, size.w);
  }
  return spots;
}
