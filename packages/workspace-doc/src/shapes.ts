/**
 * The shapes a workspace's layout travels in between the window, the store and, later, other
 * devices (docs/design/multiplayer-2026-09-28.md §8). Nothing here imports Loro, Node or
 * Electron: the window uses these types and the guard too.
 */

/** A view's layout: the view's own schema version and its data. */
export interface ViewLayout {
  v: number;
  data: unknown;
}

export function isViewLayout(x: unknown): x is ViewLayout {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    && typeof (x as ViewLayout).v === "number" && Number.isFinite((x as ViewLayout).v)
    && "data" in x;
}

/**
 * A frame as the window keeps it. The document reads `id` and `parentFrameId` (a frame nests
 * in its parent); every other field is kept as given.
 */
export interface FrameRecord {
  id: string;
  parentFrameId?: string;
}

/**
 * A tile as the window keeps it. The document reads `id` and `kind`; every other field is kept
 * as given, except `frame`, `name` and `tabs`, which the document fills from the layout's
 * per-tile maps and a tile may not use itself.
 */
export interface TileRecord {
  id: string;
  kind: string;
}

/**
 * The layout every view shares, as the window saves it (canvas-persistence.ts): the frames,
 * the open tiles in order, and each tile's name, editor tabs and frame.
 */
export interface CoreLayout {
  frames: FrameRecord[];
  tiles: TileRecord[];
  tileNames?: Record<string, string>;
  editorTabs?: Record<string, string[]>;
  frameOf?: Record<string, string>;
}
