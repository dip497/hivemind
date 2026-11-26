/**
 * The board's drawings as Layers rows, in one pass over its objects: the shapes and arrows that
 * share a drawing id make one row, a frame's shapes in no drawing make its "Shapes" row.
 */
import type { BoardObject, ShapeObject } from "@hivemind/workspace-doc/shapes";
import { drawingName, objectKindName } from "@hivemind/workspace-doc/drawing-name";
import type { DrawingRow, DrawingsByFrame } from "@hivemind/core/layers";

export interface DrawingRows { list: readonly DrawingRow[]; byFrame: DrawingsByFrame }

/** The row an object is listed in, or null for one that is no drawing (a widget, a plain arrow). */
export function drawingKey(o: BoardObject): string | null {
  if (o.kind === "widget") return null;
  return o.drawing ?? (o.kind === "shape" ? `shapes:${o.frame ?? ""}` : null);
}

/** The ids of every object in the rows `keys`, to remove or lock them together. */
export function objectsIn(objects: readonly BoardObject[], keys: ReadonlySet<string>): string[] {
  return objects.flatMap((o) => { const k = drawingKey(o); return k !== null && keys.has(k) ? [o.id] : []; });
}

/** The shapes of each drawing not in `known`, in one pass; null when every drawing is known. */
export function newDrawings(objects: readonly BoardObject[], known: ReadonlySet<string>): Map<string, ShapeObject[]> | null {
  let fresh: Map<string, ShapeObject[]> | null = null;
  for (const o of objects) {
    if (o.kind !== "shape" || !o.drawing || known.has(o.drawing)) continue;
    fresh ??= new Map();
    const shapes = fresh.get(o.drawing);
    if (shapes) shapes.push(o); else fresh.set(o.drawing, [o]);
  }
  return fresh;
}

interface Gathered {
  key: string; frameId: string | null; by?: string; objectId: string; onShape: boolean; loose: boolean;
  /** Its objects, which `drawingName` names, and whether a shape of it has writing. */
  members: BoardObject[]; written: boolean;
  texts: string[]; count: number; shapes: number; locked: number;
  /** What its first object is: its name when it is the only one. */
  first: string;
}

const shapesWord = (n: number): string => `${n} shapes`;

/**
 * The rows for `objects`. A drawing is named by its largest text, else by what it is ("Arrow",
 * "Box", "3 shapes"); its detail says the other of the two. An arrow's label is searched, not a
 * name. A frame's loose shapes are one "Shapes" row, or the one shape's own.
 * A row equal to one in `before` is that same object, and when every row is, `before` itself is
 * the answer, so what is drawn from it is kept while only places change.
 */
export function drawingRows(objects: readonly BoardObject[], before?: DrawingRows, nameOf?: (id: string) => string | undefined): DrawingRows {
  const gathered = new Map<string, Gathered>();
  for (const o of objects) {
    if (o.kind === "widget") continue;
    const key = drawingKey(o);
    if (key === null) continue;
    let g = gathered.get(key);
    if (!g) gathered.set(key, g = { key, frameId: o.frame ?? null, objectId: o.id, onShape: o.kind === "shape", loose: o.drawing === undefined, members: [], written: false, texts: [], count: 0, shapes: 0, locked: 0, first: objectKindName(o) });
    g.count++;
    g.members.push(o);
    if (o.kind === "shape") { g.shapes++; if (o.locked) g.locked++; }
    // The canvas focuses a shape; an arrow is only gone to when the drawing has nothing else.
    if (!g.onShape && o.kind === "shape") { g.objectId = o.id; g.onShape = true; }
    if (g.frameId === null && o.frame) g.frameId = o.frame;
    if (!g.by && o.by) g.by = o.by;
    const text = (o.kind === "shape" ? o.text : o.label)?.trim();
    if (!text) continue;
    g.texts.push(text);
    if (o.kind === "shape") g.written = true;
  }
  const old = new Map(before?.list.map((r) => [r.key, r]));
  const list: DrawingRow[] = [];
  const byFrame = new Map<string | null, DrawingRow[]>();
  let same = !!before && before.list.length === gathered.size;
  for (const g of gathered.values()) {
    const what = g.count === 1 ? g.first : shapesWord(g.count);
    const titled = g.written && (!g.loose || g.count === 1);
    const name = titled || (g.count === 1 && g.members[0]!.kind === "arrow") ? drawingName(g.members, nameOf) : g.loose && g.count > 1 ? "Shapes" : what;
    const lone = g.count === 1 && g.members[0]!.kind === "arrow" ? g.members[0]! : null;
    const detail = lone ? (lone.kind === "arrow" && lone.label.trim() && name !== lone.label.trim() ? lone.label.trim().split("\n", 1)[0]! : "") : titled || (g.loose && g.count > 1) ? what : "";
    const lockable = g.shapes > 0;
    const locked = lockable && g.locked === g.shapes;
    const text = [name, ...g.texts].join("\n").toLowerCase();
    const prev = old.get(g.key);
    const row: DrawingRow = prev && prev.name === name && prev.frameId === g.frameId && prev.by === g.by && prev.objectId === g.objectId && prev.text === text
      && prev.detail === detail && prev.lockable === lockable && prev.locked === locked
      ? prev
      : { key: g.key, name, frameId: g.frameId, objectId: g.objectId, text, detail, lockable, locked, ...(g.by ? { by: g.by } : {}) };
    if (row !== before?.list[list.length]) same = false;
    list.push(row);
    const rows = byFrame.get(row.frameId);
    if (rows) rows.push(row); else byFrame.set(row.frameId, [row]);
  }
  return same ? before! : { list, byFrame };
}
