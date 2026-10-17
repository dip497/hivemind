/**
 * Canvas tile/frame sizing constants + defaults — pure, shared by Canvas and the
 * extracted spawn/frame/worktree hooks so they don't import from Canvas.tsx.
 */
import type { TileKind } from "./tile-kinds";
import { WORKBENCH_TILE_ID } from "./canvas-persistence";
import { tileKind } from "./tiles";

/** Fallback tile dimensions for tiles never explicitly resized (so they have
 *  no entry in the `sizes` map). Mirrors the defaults in the nodes useMemo.
 *  Used by the frame auto-fit effect to estimate a child's box without a DOM
 *  measurement. */
export function defaultTileSize(id: string): { width: number; height: number } {
  if (id === WORKBENCH_TILE_ID || id === "tile-diff-1") return { width: 1400, height: 900 };
  if (id === "tile-issues-1") return { width: 680, height: 460 };
  // terminals + claude extras
  return { width: 1200, height: 820 };
}

/** Default size by KIND — the single source of truth for a fresh tile's box,
 *  from the plugin that draws it. Node-building, the frame auto-fit effect and
 *  placeInFrame all derive from this so the frame grows to the tile's ACTUAL size. */
export function defaultSizeForKind(kind: TileKind): { width: number; height: number } {
  return tileKind(kind).size;
}

// Snap on drop to an 8px grid (Figma's standard). The drop xyflow hands us is
// raw cursor; rounding to 8px means the node travels a few px from cursor to
// grid — and because `.canvas-dragging` is removed SYNC on dragstop, the
// `.react-flow__node` 280ms transition (Linear-app ease-out-quint) animates
// that travel. THAT is the "smooth land" moment. Below ~4px the travel is too
// small to read as motion.
const SNAP_GRID = 8;
export const snapToGrid = (v: number): number => Math.round(v / SNAP_GRID) * SNAP_GRID;

// Frame auto-fit geometry. Frames are sized to the bbox of their member tiles
// + these paddings; an empty frame collapses to the placeholder so a bound
// workspace zone stays a visible, droppable target with its header chrome.
export const FRAME_PAD = 28;
export const FRAME_HEADER = 36;
export const FRAME_EMPTY_W = 460;
export const FRAME_EMPTY_H = 200;
