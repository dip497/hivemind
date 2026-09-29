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

/** What a board object is (design §4.2 G). */
export const BOARD_OBJECT_KINDS = ["note", "checklist", "text", "arrow"] as const;
export type BoardObjectKind = (typeof BOARD_OBJECT_KINDS)[number];

/** The sides of a tile, frame or board object an arrow can meet. */
export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];

/** One end of an arrow: a tile, frame or board object, and the side of it the arrow meets. */
export interface ArrowEnd {
  id: string;
  side: Side;
}

/** One line of a checklist. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

interface BoardObjectFields {
  id: string;
  /** The frame it moves with, if any. */
  frame?: string;
  /** Stacking order among board objects: higher is in front. */
  z?: number;
  color?: string;
}

/**
 * A note, checklist or text label: a box holding text. `x` and `y` are relative to its frame's
 * top-left when it has a `frame`, so moving the frame changes nothing here; else they are on the
 * canvas. `w` and `h` are its size.
 */
interface BoxFields extends BoardObjectFields {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface NoteObject extends BoxFields { kind: "note" }
export interface TextObject extends BoxFields { kind: "text" }
/** `text` is the checklist's title. */
export interface ChecklistObject extends BoxFields { kind: "checklist"; items: ChecklistItem[] }
export interface ArrowObject extends BoardObjectFields { kind: "arrow"; from: ArrowEnd; to: ArrowEnd; label: string }

/**
 * A board object as the window keeps it. The document merges its text (`text`, `label`, each
 * item's `text`) by character and a checklist's items one by one; other fields are kept as
 * given, and the last write of each wins.
 */
export type BoardObject = NoteObject | TextObject | ChecklistObject | ArrowObject;
