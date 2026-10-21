/** Where widget cards nobody has moved yet sit: down one edge of the screen, each below the one before it. */

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
 * last, down the `edge` of the screen (the right unless the view asks for the left), and a card that
 * would run off the bottom starts a new column further in from that edge.
 */
export function stackDownEdge(ids: readonly string[], sizes: Readonly<Record<string, Size>>, screen: Size, edge: "left" | "right" = "right"): Record<string, Spot> {
  const spots: Record<string, Spot> = {};
  // How far in from the edge the column under way starts.
  let inset = EDGE;
  let y = TOP;
  let columnW = 0;
  for (const id of ids) {
    const size = sizes[id] ?? { w: CARD_W, h: UNDRAWN_H };
    if (y > TOP && y + size.h > screen.h - EDGE) {
      inset += columnW + GAP;
      y = TOP;
      columnW = 0;
    }
    const x = edge === "left" ? inset : screen.w - inset - size.w;
    spots[id] = { x: Math.min(Math.max(x, 0), Math.max(screen.w - size.w, 0)), y };
    y += size.h + GAP;
    columnW = Math.max(columnW, size.w);
  }
  return spots;
}
