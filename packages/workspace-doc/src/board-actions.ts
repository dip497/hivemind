/**
 * Every action on what is on the board, once, for each surface that does it: the window's buttons
 * and the workspace API's `board.change`. Each takes the board in canvas coordinates and answers only
 * the objects it changed (null: taken away), so an object that did not change is not written.
 * Loro-free, for the window and the host alike.
 */
import { alignRects, type AlignHow } from "./align.js";
import { MAX_SHAPES_ON_BOARD, boundsOf, type Point, type Rect } from "./drawing.js";
import type { ArrowObject, BoardObject, ShapeObject, WidgetObject } from "./shapes.js";

export type { AlignHow };

/** What changed, by id; null: taken away. */
export type BoardChanges = Record<string, BoardObject | null>;

/** Something with a box on the board: a shape, or a widget placed on it. */
export type BoxObject = ShapeObject | (WidgetObject & Rect);

/** The frame a box's centre is now in, so a box moved into a frame moves with it; none: frames stay as they are. */
export type FrameAt = (centre: Point) => string | undefined;

/** What restyling sets: on a shape any of these, on an arrow its colour, dash and weight. */
export type ObjectStyle = Partial<Pick<ShapeObject, "color" | "filled" | "dash" | "weight" | "rough" | "size">>;

export const isBox = (o: BoardObject): o is BoxObject => o.kind === "shape" || (o.kind === "widget" && o.placement === "board");
export const isLocked = (o: BoardObject): boolean => o.kind === "shape" && o.locked === true;

const chosenFrom = (objects: readonly BoardObject[], ids: Iterable<string>): BoardObject[] => {
  const wanted = new Set(ids);
  return objects.filter((o) => wanted.has(o.id));
};

/** A box at `x`, `y`, in the frame `frameAt` finds for it; itself when that changes nothing. */
function boxAt(o: BoxObject, x: number, y: number, frameAt?: FrameAt): BoxObject {
  const frame = frameAt ? frameAt({ x: x + o.w / 2, y: y + o.h / 2 }) : o.frame;
  if (x === o.x && y === o.y && frame === o.frame) return o;
  const { frame: _was, ...rest } = o;
  return { ...rest, x, y, ...(frame ? { frame } : {}) } as BoxObject;
}

/** Lock or unlock the shapes with `ids`: a locked shape is not moved, resized or erased. */
export function lockObjects(objects: readonly BoardObject[], ids: Iterable<string>, locked: boolean): BoardChanges {
  const out: BoardChanges = {};
  for (const o of chosenFrom(objects, ids)) {
    if (o.kind !== "shape" || (o.locked === true) === locked) continue;
    const { locked: _was, ...rest } = o;
    out[o.id] = locked ? { ...rest, locked: true } : rest;
  }
  return out;
}

/** Bring the objects with `ids` in front of everything else on the board, or behind it, keeping their own order. */
export function restack(objects: readonly BoardObject[], ids: Iterable<string>, to: "front" | "back"): BoardChanges {
  const wanted = new Set(ids);
  const order = objects.filter((o) => wanted.has(o.id)).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  if (order.length === 0) return {};
  const others = objects.filter((o) => !wanted.has(o.id));
  const first = to === "front"
    ? others.reduce((z, o) => Math.max(z, o.z ?? 0), 0) + 1
    : others.reduce((z, o) => Math.min(z, o.z ?? 0), 0) - order.length;
  const out: BoardChanges = {};
  order.forEach((o, i) => { if (o.z !== first + i) out[o.id] = { ...o, z: first + i }; });
  return out;
}

/** Line up the boxes with `ids` as `how` says; a locked shape stays where it is. */
export function alignObjects(objects: readonly BoardObject[], ids: Iterable<string>, how: AlignHow, frameAt?: FrameAt): BoardChanges {
  const boxes = chosenFrom(objects, ids).filter((o): o is BoxObject => isBox(o) && !isLocked(o));
  const out: BoardChanges = {};
  for (const [id, p] of alignRects(boxes, how)) {
    const o = boxes.find((b) => b.id === id)!;
    const moved = boxAt(o, p.x, p.y, frameAt);
    if (moved !== o) out[id] = moved;
  }
  return out;
}

/** Move the boxes with `ids` so the corner of what they cover together is at `to`, keeping them as
 *  they are to each other; a locked shape stays. */
export function moveObjects(objects: readonly BoardObject[], ids: Iterable<string>, to: Point, frameAt?: FrameAt): BoardChanges {
  const boxes = chosenFrom(objects, ids).filter((o): o is BoxObject => isBox(o) && !isLocked(o));
  const from = boundsOf(boxes);
  if (!from) return {};
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const out: BoardChanges = {};
  for (const o of boxes) {
    const moved = boxAt(o, o.x + dx, o.y + dy, frameAt);
    if (moved !== o) out[o.id] = moved;
  }
  return out;
}

/** Restyle the shapes and arrows with `ids`: an arrow takes only colour, dash and weight. */
export function styleObjects(objects: readonly BoardObject[], ids: Iterable<string>, change: ObjectStyle): BoardChanges {
  const out: BoardChanges = {};
  const arrowChange: Partial<ArrowObject> = {
    ...(change.color !== undefined ? { color: change.color } : {}),
    ...(change.dash !== undefined ? { dash: change.dash } : {}),
    ...(change.weight !== undefined ? { weight: change.weight } : {}),
  };
  for (const o of chosenFrom(objects, ids)) {
    const fields: Partial<BoardObject> = o.kind === "shape" ? change : o.kind === "arrow" ? arrowChange : {};
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (keys.length === 0 || keys.every((k) => (o as Partial<BoardObject>)[k] === fields[k])) continue;
    out[o.id] = { ...o, ...fields } as BoardObject;
  }
  return out;
}

/**
 * Copies of the boxes with `ids`, and of the arrows between them, moved by `dx`, `dy`, in front of
 * everything: a drawing copied whole is a drawing of its own, and a copy is never locked. Refused (a
 * TypeError) when the board would hold more shapes than it takes.
 */
export function duplicateObjects(objects: readonly BoardObject[], ids: Iterable<string>, mint: (kind: string) => string, dx: number, dy: number): BoardChanges {
  const boxes = chosenFrom(objects, ids).filter(isBox);
  const shapes = objects.reduce((n, o) => n + (o.kind === "shape" ? 1 : 0), 0);
  const adding = boxes.reduce((n, o) => n + (o.kind === "shape" ? 1 : 0), 0);
  if (shapes + adding > MAX_SHAPES_ON_BOARD) {
    throw new TypeError(`this board holds ${shapes} shapes and takes at most ${MAX_SHAPES_ON_BOARD}: erase some before copying ${adding} more`);
  }
  const newIds = new Map<string, string>();
  const drawings = new Map<string, string>();
  const drawingOf = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    if (!drawings.has(id)) drawings.set(id, mint("drawing"));
    return drawings.get(id);
  };
  let z = objects.reduce((top, o) => Math.max(top, o.z ?? 0), 0) + 1;
  const out: BoardChanges = {};
  for (const o of boxes) {
    const id = mint(o.kind);
    newIds.set(o.id, id);
    if (o.kind === "shape") {
      const { drawing, locked: _unlocked, ...shape } = o;
      const group = drawingOf(drawing);
      out[id] = { ...shape, id, x: o.x + dx, y: o.y + dy, z: z++, ...(group ? { drawing: group } : {}) };
    } else {
      const copy = { ...o, id, x: o.x + dx, y: o.y + dy, z: z++ };
      out[id] = copy.items ? { ...copy, items: copy.items.map((item) => ({ ...item, id: mint("item") })) } : copy;
    }
  }
  for (const o of objects) {
    if (o.kind !== "arrow") continue;
    const [from, to] = [newIds.get(o.from.id), newIds.get(o.to.id)];
    if (!from || !to) continue;
    const { drawing, ...arrow } = o;
    const group = drawingOf(drawing);
    const id = mint("arrow");
    out[id] = { ...arrow, id, z: z++, from: { ...o.from, id: from }, to: { ...o.to, id: to }, ...(group ? { drawing: group } : {}) };
  }
  return out;
}
