/**
 * Canvas tile/frame sizing constants + defaults — pure, shared by Canvas and the
 * extracted spawn/frame/worktree hooks so they don't import from Canvas.tsx.
 */
import type { TileKind } from "./tile-kinds";
import { WORKBENCH_TILE_ID } from "./canvas-persistence";

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

/** Default size by KIND — the single source of truth for a fresh tile's box.
 *  Node-building, the frame auto-fit effect, and placeInFrame all derive from
 *  this so the frame grows to the tile's ACTUAL rendered size. */
export function defaultSizeForKind(kind: TileKind): { width: number; height: number } {
  switch (kind) {
    case "editor":
    case "diff":
      return { width: 1400, height: 900 };
    case "issues":
      return { width: 680, height: 460 };
    case "planReview":
      // Roomy enough to read a full plan without scrolling the whole thing.
      return { width: 820, height: 720 };
    case "browser":
      return { width: 1280, height: 860 };
    case "claude":
      // Compact default — the larger 15px terminal font makes a smaller tile
      // read comfortably, and a tighter box leaves more canvas free.
      return { width: 1100, height: 740 };
    case "shell":
    default:
      return { width: 1200, height: 820 };
  }
}

// Frame auto-fit geometry. Frames are sized to the bbox of their member tiles
// + these paddings; an empty frame collapses to the placeholder so a bound
// workspace zone stays a visible, droppable target with its header chrome.
export const FRAME_PAD = 28;
export const FRAME_HEADER = 36;
export const FRAME_EMPTY_W = 460;
export const FRAME_EMPTY_H = 200;
