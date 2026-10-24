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
  /** Agent only: the issue it was started to work (design jira-sync §11.1), e.g. `PAY-318`. */
  issue?: string;
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

/** What a board object is (design §4.2 G): an arrow, or a widget (notes, checklists and text labels are widgets). */
export const BOARD_OBJECT_KINDS = ["arrow", "widget"] as const;
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
 */
export interface WidgetObject extends BoardObjectFields {
  kind: "widget";
  widget: string;
  placement?: "board" | "screen";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  items?: ChecklistItem[];
  state?: unknown;
  options?: Record<string, unknown>;
}
export interface ArrowObject extends BoardObjectFields { kind: "arrow"; from: ArrowEnd; to: ArrowEnd; label: string }

/**
 * A board object as the window keeps it. The document merges its text (`text`, `label`, each
 * item's `text`) by character and a list's items one by one; other fields are kept as given, and
 * the last write of each wins. A note, checklist or text label an older version wrote is read as
 * the widget it is now.
 */
export type BoardObject = ArrowObject | WidgetObject;

/** Some of the board's objects as a writer changed them, by id (null: it took the object away),
 *  and each as it was when the writer made the change (null: it was not there). An object without
 *  one there is written as given. */
export interface BoardEdit {
  objects: Record<string, BoardObject | null>;
  base?: Record<string, BoardObject | null>;
}

/** The most a widget's `state`, or what it draws, may take, as JSON. */
export const WIDGET_FIELD_BYTES = 16_384;
