/**
 * Board objects on the canvas (docs/design/multiplayer-2026-09-28.md, R15, §4.2 G): the pure part.
 *
 * The window keeps every object's position on the canvas, as it keeps tiles', so a frame drag,
 * the frames' auto-fit and their separation move objects exactly as they move tiles. The store
 * keeps a framed object's position relative to its frame (workspace-doc objects.ts), so moving a
 * frame changes nothing there and an undo never drops a note outside its frame. The two convert
 * here and nowhere else. Also here: what a new object is, which sides an arrow joins, where it
 * meets them, and what a board edit takes with it.
 */
import type { BoardObject, Side, WidgetObject } from "@hivemind/workspace-doc/shapes";
import { frameAtPoint } from "../frame-layout";
import type { FrameState } from "../canvas-persistence";

/** A widget placed on the board: it has a box, and moves with its frame, as a note does. */
export type BoardWidget = WidgetObject & { placement: "board"; x: number; y: number; w: number; h: number };
/** What sits on the board in a box: a widget placed there (a note, a checklist and text are widgets). */
export type BoxObject = BoardWidget;
export type ArrowObject = Extract<BoardObject, { kind: "arrow" }>;
export type BoxKind = BoxObject["kind"];
/** What the Add menu adds: an arrow, or a widget of the package named after `widget:`. */
export type BoardChoice = "arrow" | `widget:${string}`;

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** The smallest a resize leaves a box. */
export const BOX_SIZE: Record<BoxKind, { minW: number; minH: number }> = {
  widget: { minW: 80, minH: 36 },
};

/** The widgets floating over every view (not placed on the board), oldest first. */
export function widgetsOf(board: BoardObject[]): WidgetObject[] {
  return board.filter((o): o is WidgetObject => o.kind === "widget" && o.placement !== "board")
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What a view brings of its package's switched-on widgets (`members`, in the package's order) to a
 *  workspace that holds `onBoard` and was brought `brought` before: those to add, and those now
 *  counted as brought. One already on the board is brought without a second copy; one brought
 *  before is never brought again, closed or not. */
export function widgetsToBring(members: readonly string[], onBoard: readonly string[], brought: readonly string[]): { add: string[]; brought: string[] } {
  const fresh = members.filter((id) => !brought.includes(id));
  return { add: fresh.filter((id) => !onBoard.includes(id)), brought: fresh };
}

export function isBox(o: BoardObject): o is BoxObject {
  return o.kind === "widget" && o.placement === "board";
}

/** Whether a canvas node of this type is a board box: a box's node type is its kind. */
export function isBoxType(type: string | undefined): type is BoxKind {
  return type !== undefined && Object.hasOwn(BOX_SIZE, type);
}

/** The board as the store keeps it, as the canvas draws it. */
export function toCanvas(stored: BoardObject[], frames: FrameState[]): BoardObject[] {
  const byId = new Map(frames.map((f) => [f.id, f]));
  return stored.map((o) => {
    const frame = isBox(o) && o.frame ? byId.get(o.frame) : undefined;
    return frame && isBox(o) ? { ...o, x: o.x + frame.x, y: o.y + frame.y } : o;
  });
}

/** The board as the canvas draws it, as the store keeps it. An object whose frame is gone stays where it is, loose. */
export function toStored(objects: BoardObject[], frames: FrameState[]): BoardObject[] {
  const byId = new Map(frames.map((f) => [f.id, f]));
  return objects.map((o) => {
    if (!isBox(o) || o.frame === undefined) return o;
    const frame = byId.get(o.frame);
    if (!frame) {
      const { frame: _gone, ...loose } = o;
      return loose;
    }
    return { ...o, x: o.x - frame.x, y: o.y - frame.y };
  });
}

/** The frame a point on the canvas is in: the innermost, then the front-most. */
export function frameAt(frames: FrameState[], p: Point): string | undefined {
  return frameAtPoint([...frames].sort((a, b) => b.z - a.z), p.x, p.y)?.id;
}

/** A new, empty box of `kind` centred on `at`, in the frame there if there is one. */
/** A new widget of the package `pkg`: on the board, `size` centred on `at` and in the frame there;
 *  else floating over every view. */
export function newWidget(pkg: string, id: string, z: number, board?: { at: Point; size: { w: number; h: number }; lines?: boolean; frames: FrameState[] }): WidgetObject {
  if (!board) return { id, kind: "widget", widget: pkg, z };
  const { at, size, frames } = board;
  const frame = frameAt(frames, at);
  // Its writing exists from the start, as a new note's did: one typed into later is an edit of
  // it, which undo and redo take back and make again whole.
  return { id, kind: "widget", widget: pkg, z, placement: "board", x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2), w: size.w, h: size.h, text: "", ...(board.lines ? { items: [] } : {}), ...(frame ? { frame } : {}) };
}

/** A copy of a box just below and right of it, with new ids for it and its items. Arrows stay with the original. */
export function duplicateBox(o: BoxObject, id: string, z: number, itemId: () => string): BoxObject {
  const copy = { ...o, id, x: o.x + 24, y: o.y + 24, z };
  return copy.items ? { ...copy, items: copy.items.map((item) => ({ ...item, id: itemId() })) } : copy;
}

/** The board without `id`, and without any arrow that ends on it. */
export function withoutObject(board: BoardObject[], id: string): BoardObject[] {
  return board.filter((o) => o.id !== id && !(o.kind === "arrow" && (o.from.id === id || o.to.id === id)));
}

/** The next stacking order: in front of everything on the board. */
export function frontZ(board: BoardObject[]): number {
  return board.reduce((z, o) => Math.max(z, o.z ?? 0), 0) + 1;
}

/** The sides two rects face each other on: along the axis their centres are furthest apart on. */
export function facingSides(from: Rect, to: Rect): [Side, Side] {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/** Where an arrow meets a rect's side: the middle of it. */
export function sidePoint(r: Rect, side: Side): Point {
  switch (side) {
    case "top": return { x: r.x + r.w / 2, y: r.y };
    case "right": return { x: r.x + r.w, y: r.y + r.h / 2 };
    case "bottom": return { x: r.x + r.w / 2, y: r.y + r.h };
    case "left": return { x: r.x, y: r.y + r.h / 2 };
  }
}

/** The first of `frontToBack` a point is in: what a click there lands on. */
export function hitTest<T extends { rect: Rect }>(p: Point, frontToBack: T[]): T | undefined {
  return frontToBack.find(({ rect: r }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
}
