/**
 * A board edit (`BoardEdit`) made and applied as plain objects, with no document: what a window
 * sends of its board, and how what it holds takes what changed. Loro-free, for the renderer.
 */
import { sameJson } from "./rebase.js";
import type { BoardEdit, BoardObject } from "./shapes.js";

/** The edit that makes `base` into `next`: each object that is not the same, or is gone. */
export function boardEdit(base: readonly BoardObject[], next: readonly BoardObject[]): BoardEdit {
  const was = new Map(base.map((o) => [o.id, o]));
  const edit: Required<BoardEdit> = { objects: {}, base: {} };
  for (const object of next) {
    const before = was.get(object.id);
    was.delete(object.id);
    if (before === object || sameJson(before, object)) continue;
    edit.objects[object.id] = object;
    edit.base[object.id] = before ?? null;
  }
  for (const [id, before] of was) {
    edit.objects[id] = null;
    edit.base[id] = before;
  }
  return edit;
}

/** `board` with the objects in `changed` put in place of their own, or taken away (null); the
 *  new ones after the rest. */
export function withObjects(board: readonly BoardObject[], changed: Readonly<Record<string, BoardObject | null>>): BoardObject[] {
  const left = new Map(Object.entries(changed));
  const next: BoardObject[] = [];
  for (const object of board) {
    if (!left.has(object.id)) next.push(object);
    else {
      const now = left.get(object.id);
      left.delete(object.id);
      if (now) next.push(now);
    }
  }
  for (const now of left.values()) if (now) next.push(now);
  return next;
}
