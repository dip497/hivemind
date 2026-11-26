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
 * A frame as the window keeps it: a box on the canvas that groups tiles, and can bind them to a
 * folder or a worktree. The document reads `id` and `parentFrameId` (a frame nests in its
 * parent), the control plane its title and where its tiles run; every other field (its place,
 * colour, a remote host) is the window's, kept as given.
 */
export interface FrameRecord {
  id: string;
  title: string;
  /** The git branch its tiles run on, isolated in `worktreePath`. */
  branch?: string;
  /** The worktree for `branch`: its tiles' working folder. */
  worktreePath?: string;
  /** A folder its tiles run in, so several projects can share one canvas. */
  workspacePath?: string;
  /** Set on a worktree's frame, nested in the frame of the repository it belongs to. */
  parentFrameId?: string;
  /** Opens into a page of its own: what it holds is drawn only inside it, and on its parent it is a card. */
  page?: true;
}

/**
 * A tile as the window keeps it. The document reads `id` and `kind`, the control plane what it
 * is called and what runs in it; every other field is the window's, kept as given, except
 * `frame`, `name` and `tabs`, which the document fills from the layout's per-tile maps and a
 * tile may not use itself.
 */
export interface TileRecord {
  id: string;
  kind: string;
  label: string;
  /** Agent and shell only: the program it runs. */
  cmd?: string;
  /** Agent only: what it was started to do, from its first prompt. Shown until the agent says. */
  task?: string;
  /** Terminal only: an existing session it shows (started by `hive run` or another device). It
   *  never starts one, and closing it only lets go. */
  session?: string;
  /** Agent only: put to sleep, in this folder (where its session is kept, however its frame moves).
   *  Its process ended; its last screen and its conversation wait for it to be woken
   *  (docs/design/sleep-agents-2026-10-17.md). */
  sleeping?: string;
  /** Agent only: when it was put to sleep (ms since epoch), while it sleeps. */
  sleptAt?: number;
}

/** The kind every agent's tile has, whatever runs in it: the historical id, kept for saved
 *  layouts. The only place a provider's name appears as a literal outside its own definition. */
export const AGENT_TILE_KIND = "claude" as const;

/** What a tile is: the kind a tile plugin registered. A board keeps a kind no installed
 *  plugin draws, so installing the plugin later brings its tiles back. */
export type TileKind = string;

/** A tile that runs in a terminal, an agent's or a shell: the kinds with a session. */
export const isTerminalKind = (kind: string): boolean => kind === AGENT_TILE_KIND || kind === "shell";

/**
 * The layout every view shares, as the window saves it (canvas-persistence.ts): the frames,
 * the open tiles in order, and each tile's name, editor tabs and frame.
 */
/** What every reader shares: nothing may change it. */
export type Frozen<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

/** A core layout as the store keeps it, shared by every reader until the workspace changes. */
export type KeptCore = Frozen<CoreLayout>;

export interface CoreLayout {
  frames: FrameRecord[];
  tiles: TileRecord[];
  tileNames?: Record<string, string>;
  editorTabs?: Record<string, string[]>;
  frameOf?: Record<string, string>;
}

/** What a board object is (design §4.2 G): an arrow, a widget (notes, checklists and text labels are widgets), or a shape someone drew. */
export const BOARD_OBJECT_KINDS = ["arrow", "widget", "shape"] as const;
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
 * A widget: what a plugin draws, the app's own sticky note, checklist and text label among them.
 * `widget` names its package. It sits on the board (`placement: "board"`, with a box: `x` and `y`
 * relative to its frame's top-left when it has a `frame`, so moving the frame changes nothing here,
 * else on the canvas; `w` and `h` its size) or floats over every view (the default), where each
 * person places it on their own screen.
 *
 * What people write in it is its content, merged as a note's is: `text` by character, `items` (a
 * list's lines) one by one; changing it is an edit, taken back by undo. `state` is what its code
 * keeps and `options` what the person set for it, each capped at `WIDGET_FIELD_BYTES`; neither is
 * an undo step. What it draws is never stored here (the workspace API's `widget.drawn`).
 *
 * `view` names the view that brought it (a package's view brings the package's widgets): a
 * floating widget with one is drawn only while that view is on screen, until someone chooses to
 * show it on every view, which takes `view` away. An app that predates it draws it over every view.
 */
export interface WidgetObject extends BoardObjectFields {
  kind: "widget";
  widget: string;
  placement?: "board" | "screen";
  view?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  items?: ChecklistItem[];
  state?: unknown;
  options?: Record<string, unknown>;
}
export interface ArrowObject extends BoardObjectFields {
  kind: "arrow";
  from: ArrowEnd;
  to: ArrowEnd;
  label: string;
  /** Drawn by an agent, as part of a drawing (`ShapeObject`). */
  by?: string;
  drawing?: string;
  /** How it gets from one end to the other; absent: the curve it always was. */
  route?: ArrowRoute;
  dash?: ShapeDash;
  weight?: ShapeWeight;
  /** Where on each end's box it meets, as fractions 0..1 of the box; absent: the middle of the side. */
  fromAt?: [number, number];
  toAt?: [number, number];
  /** An arrowhead at the start too. */
  tail?: boolean;
}

/** How an arrow gets from one end to the other. */
export const ARROW_ROUTES = ["straight", "elbow", "curve"] as const;
export type ArrowRoute = (typeof ARROW_ROUTES)[number];
/** How a line is drawn along its length, and how heavy it is. */
export const SHAPE_DASHES = ["solid", "dashed", "dotted"] as const;
export type ShapeDash = (typeof SHAPE_DASHES)[number];
export const SHAPE_WEIGHTS = ["thin", "medium", "thick"] as const;
export type ShapeWeight = (typeof SHAPE_WEIGHTS)[number];

/** What a shape is. */
export const SHAPE_FORMS = ["rect", "ellipse", "diamond", "text", "line", "pen", "triangle", "hexagon", "cylinder", "cloud", "star", "parallelogram", "image"] as const;
export type ShapeForm = (typeof SHAPE_FORMS)[number];
/** The forms drawn along points, not filling their box. */
export const isStroke = (form: ShapeForm): boolean => form === "line" || form === "pen";
/** The colours a shape is drawn in, by name, so each theme can draw them as it reads best. */
export const SHAPE_COLORS = ["ink", "blue", "green", "yellow", "orange", "red", "purple"] as const;
export type ShapeColor = (typeof SHAPE_COLORS)[number];
export const SHAPE_TEXT_SIZES = ["small", "medium", "large"] as const;
export type ShapeTextSize = (typeof SHAPE_TEXT_SIZES)[number];
/** The most points a line or a stroke of the pen keeps. */
export const MAX_SHAPE_POINTS = 2000;

/** The kinds of picture the board shows. */
export const BOARD_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type BoardImageType = (typeof BOARD_IMAGE_TYPES)[number];
/** A picture on the board, by what it is: its bytes are kept beside the workspace under `hash`
 *  (sha256, hex) and fetched by it (`board.image`); the document never holds them. */
export interface BoardImage {
  hash: string;
  type: BoardImageType;
  /** Its size in pixels, as kept. */
  width: number;
  height: number;
}
/** The most characters a picture's alt text keeps. */
export const MAX_ALT = 500;

export function isBoardImage(x: unknown): x is BoardImage {
  if (typeof x !== "object" || x === null) return false;
  const i = x as Record<string, unknown>;
  return typeof i.hash === "string" && /^[0-9a-f]{64}$/.test(i.hash) && (BOARD_IMAGE_TYPES as readonly unknown[]).includes(i.type)
    && [i.width, i.height].every((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
}

/**
 * What a person or an agent drew: a box with a form, kept as a note is (`x` and `y` relative to its
 * frame when it has one, else on the canvas), and an arrow can end on it. `points`, of a line or a
 * stroke of the pen, are relative to the box's corner. `text` merges by character, as a note's does.
 */
export interface ShapeObject extends BoardObjectFields {
  kind: "shape";
  form: ShapeForm;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  size?: ShapeTextSize;
  points?: Array<[number, number]>;
  /** A line that ends in an arrowhead. */
  head?: boolean;
  filled?: boolean;
  /** The agent that drew it, by its tile; none when a person did. */
  by?: string;
  /** The drawing it is part of: drawn in one go, and moved and erased together. */
  drawing?: string;
  /** The name its box was given in the drawing, which an update of the drawing finds it by. */
  key?: string;
  dash?: ShapeDash;
  weight?: ShapeWeight;
  /** Drawn with a hand's wobble. */
  rough?: boolean;
  /** Cannot be moved, resized or erased. */
  locked?: boolean;
  /** A stroke of the pen drawn wide and see-through, as a highlighter. */
  marker?: boolean;
  /** The picture an `image` shape shows, and what it shows in words. */
  image?: BoardImage;
  alt?: string;
}

/** Takes away each style field of a stored shape or arrow that does not hold what it may: the object stays. */
export function dropBadStyle(fields: Record<string, unknown>): void {
  const oneOf = (key: string, allowed: readonly unknown[]): void => { if (fields[key] !== undefined && !allowed.includes(fields[key])) delete fields[key]; };
  const yesOrNo = (key: string): void => { if (fields[key] !== undefined && typeof fields[key] !== "boolean") delete fields[key]; };
  const fraction = (key: string): void => {
    const v = fields[key];
    if (v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && n >= 0 && n <= 1))) delete fields[key];
  };
  oneOf("dash", SHAPE_DASHES);
  oneOf("weight", SHAPE_WEIGHTS);
  oneOf("route", ARROW_ROUTES);
  for (const key of ["rough", "locked", "marker", "tail"]) yesOrNo(key);
  fraction("fromAt");
  fraction("toAt");
}

/**
 * A board object as the window keeps it. The document merges its text (`text`, `label`, each
 * item's `text`) by character and a list's items one by one; other fields are kept as given, and
 * the last write of each wins. A note, checklist or text label an older version wrote is read as
 * the widget it is now.
 */
export type BoardObject = ArrowObject | WidgetObject | ShapeObject;

/** Some of the board's objects as a writer changed them, by id (null: it took the object away),
 *  and each as it was when the writer made the change (null: it was not there). An object without
 *  one there is written as given. */
export interface BoardEdit {
  objects: Record<string, BoardObject | null>;
  base?: Record<string, BoardObject | null>;
}

/** The most a widget's `state`, or what it draws, may take, as JSON. */
export const WIDGET_FIELD_BYTES = 16_384;
