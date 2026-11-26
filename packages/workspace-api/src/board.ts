/** What the workspace API says of what is drawn on the board (0.42, `board.*`). */
import type { BoardComment } from "@hivemind/core/review-shape";
import type { AlignHow } from "@hivemind/workspace-doc/board-actions";
import type { DrawAsked, PictureTheme, Rect } from "@hivemind/workspace-doc/drawing";
import type { DrawProblem } from "@hivemind/workspace-doc/draw-problems";
import type { ArrowObject, ShapeColor, ShapeDash, ShapeObject, ShapeWeight } from "@hivemind/workspace-doc/shapes";

export type { AlignHow, BoardComment, DrawAsked, DrawProblem, PictureTheme, Rect };

/** What `board.draw` takes: a drawing, and the page or frame it goes inside (null: in no page; left out: where it is drawn near). */
export type BoardDrawAsk = DrawAsked & { page?: string | null };

/** What `board.draw` drew. */
export interface BoardDrawn {
  /** The drawing's id: `board.erase` takes it, a later `board.draw` can `update` it. */
  drawing: string;
  /** The shapes and arrows drawn, by their ids. */
  objects: string[];
  /** Each box asked for, by the id it was given, as the shape's id on the board. */
  boxes: Record<string, string>;
  /** Where it landed, on the canvas. */
  box: Rect;
  /** The frame it moves with. */
  frame?: string;
  /** What it landed on top of: worth moving, or drawing again. */
  overlaps: Array<{ shape: string; with: string }>;
  /** What is wrong with it as drawn, each with what to do about it; empty when nothing is. */
  problems: DrawProblem[];
  /** An update (0.43): the shapes and arrows it made, those it changed, those it erased. */
  added?: string[];
  changed?: string[];
  erased?: string[];
  /** An update: left as they were, locked by the person. */
  locked?: string[];
}

/** Who changed the board: the person (at a window, or another device), an agent, a view, or the app itself. */
export type BoardChangeAuthor = "person" | "agent" | "view" | "app";

/** One change to the board (`board.changes`, 0.43). */
export interface BoardChange {
  seq: number;
  /** When, in ms since 1970. */
  at: number;
  by: BoardChangeAuthor;
  /** The agent's tile, the view's id, or the other device or part of the app that wrote it. */
  who?: string;
  /** The objects it changed; null: any may have. */
  objects: string[] | null;
}

export interface BoardChanges {
  /** The last change's number: ask again with it as `since`. */
  seq: number;
  changes: BoardChange[];
  /** Of the objects those changes name, those not on the board now. */
  erased: string[];
  /** Some changes since then are no longer kept (or the host started again): read the board. */
  lost?: true;
}

/** What each window, or another device, showing the workspace has selected now (`board.selected`, 0.43). */
export interface BoardSelection {
  windows: Array<{ window: string; person: string; name: string; selected: BoardItem[] }>;
}

export interface BoardAsk {
  /** These objects in full, points and all; an overview without. */
  ids?: string[];
  /** Every object of this drawing, in full. */
  drawing?: string;
  /** How many objects an overview lists: 200 if left out, the rest counted in `more`. */
  limit?: number;
  /** Also say what is wrong with what is drawn there (`problems`). */
  check?: boolean;
  /** The page or frame to read: what is inside it, at any depth; null or left out: the whole canvas. */
  page?: string | null;
  /** With `drawing` (0.43): also as the flowchart text `board.draw` takes, keyed, to send back as an `update` (`text`). */
  as?: "text";
}

/** An object as an overview lists it: enough to tell what it is and where. */
export interface BoardItem {
  id: string;
  kind: string;
  box?: Rect;
  form?: string;
  widget?: string;
  /** What it says; a picture's alt text. */
  text?: string;
  /** A picture's hash: `board.image` gives its bytes. */
  image?: string;
  by?: string;
  drawing?: string;
  frame?: string;
  from?: string;
  to?: string;
}

export interface BoardReading {
  /** The frames read, pages among them marked (`page`). */
  frames: Array<{ id: string; title: string; box: Rect; page?: true }>;
  tiles: Array<{ id: string; name: string; kind: string; box: Rect; frame?: string }>;
  /** What was drawn in one go, each with its first line of writing. */
  drawings: Array<{ id: string; title: string; by?: string; box: Rect; objects: number }>;
  objects: BoardItem[];
  /** Asked for in full: canvas coordinates, whatever frame each is in. */
  full?: Array<ShapeObject | ArrowObject>;
  /** How many more objects an overview left out. */
  more?: number;
  /** Asked for with `check`: what is wrong with what is drawn, each with what to do about it. */
  problems?: DrawProblem[];
  /** Asked for `as: "text"`: the drawing as flowchart text. */
  text?: string;
}

export interface BoardPictureAsk {
  /** One drawing; everything drawn if left out. */
  drawing?: string;
  theme?: PictureTheme;
  /** As a PNG: only where a window can draw one. */
  png?: boolean;
  /** What is drawn inside this page or frame; null or left out: the whole canvas. */
  page?: string | null;
}

export type BoardPicture = { width: number; height: number } & ({ svg: string } | { png: string });

export interface BoardEraseAsk {
  ids?: string[];
  drawing?: string;
  /** All this agent drew, by its tile; `me`: the caller. */
  by?: string;
  /** Only what is inside this page or frame; null or left out: anywhere. */
  page?: string | null;
}

/** What `board.change` changes on shapes and arrows already drawn: where they are, how they look, or both. */
export interface BoardChangeAsk {
  /** Shapes and arrows by id, or a drawing's id for all of it. */
  ids: string[];
  /** Move them so their top-left corner is here on the canvas, keeping them as they are to each other. */
  to?: { x: number; y: number };
  color?: ShapeColor;
  dash?: ShapeDash;
  weight?: ShapeWeight;
  rough?: boolean;
  /** Lock them so they cannot be moved, resized or erased, or unlock them. */
  locked?: boolean;
  /** In front of everything else on the board, or behind it. */
  stack?: "front" | "back";
  /** Line them up with each other, or spread them evenly. */
  align?: AlignHow;
  /** Copy them, this far from where they are; a copy is never locked. */
  duplicate?: { dx: number; dy: number };
  /** Move them into this page or frame; null: out of the page they are in. */
  page?: string | null;
}

export interface BoardChanged {
  changed: string[];
  /** Left as they were: locked by the person. */
  locked: string[];
  /** Asked to `duplicate`: the copies made, shapes and the arrows between them, by id. */
  copies?: string[];
}

export interface BoardNoteAsked {
  body: string;
  /** The tile, frame or object it is pinned to. */
  on?: string;
  /** From `on`'s corner, else on the canvas; the corner of `on` if left out. */
  at?: { x: number; y: number };
}
