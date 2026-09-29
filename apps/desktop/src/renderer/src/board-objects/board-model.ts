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
import type { BoardObject, Side } from "@hivemind/workspace-doc/shapes";
import { frameAtPoint } from "../frame-layout";
import type { FrameState } from "../canvas-persistence";

export type BoxObject = Exclude<BoardObject, { kind: "arrow" }>;
export type ArrowObject = Extract<BoardObject, { kind: "arrow" }>;
export type BoxKind = BoxObject["kind"];

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** A sticky note's colours, in the order the picker shows them. */
export const NOTE_COLORS = ["yellow", "peach", "pink", "violet", "blue", "green"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/** A new box's size, and the smallest a resize leaves it. */
export const BOX_SIZE: Record<BoxKind, { w: number; h: number; minW: number; minH: number }> = {
  note: { w: 220, h: 180, minW: 120, minH: 80 },
  checklist: { w: 260, h: 200, minW: 180, minH: 96 },
  text: { w: 320, h: 64, minW: 80, minH: 36 },
};

export function isBox(o: BoardObject): o is BoxObject {
  return o.kind !== "arrow";
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
export function newBox(kind: BoxKind, id: string, at: Point, frames: FrameState[], z: number): BoxObject {
  const { w, h } = BOX_SIZE[kind];
  const frame = frameAt(frames, at);
  const base = { id, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, z, text: "", ...(frame ? { frame } : {}) };
  if (kind === "note") return { ...base, kind, color: NOTE_COLORS[0] };
  if (kind === "checklist") return { ...base, kind, items: [] };
  return { ...base, kind };
}

/** A copy of a box just below and right of it, with new ids for it and its items. Arrows stay with the original. */
export function duplicateBox(o: BoxObject, id: string, z: number, itemId: () => string): BoxObject {
  const copy = { ...o, id, x: o.x + 24, y: o.y + 24, z };
  return copy.kind === "checklist" ? { ...copy, items: copy.items.map((item) => ({ ...item, id: itemId() })) } : copy;
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
