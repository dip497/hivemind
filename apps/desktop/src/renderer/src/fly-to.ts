/**
 * What the camera goes to when anything "goes to" something (`flyTo` in the window): the box a
 * frame, tile, board object or drawing takes on the canvas, from state alone. Pure.
 */
import { isBox as isBoardBox } from "@hivemind/workspace-doc/board-actions";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";

export interface Box { x: number; y: number; w: number; h: number }

/** Somewhere to go: an id (frame, tile, board object, or a drawing's id), several ids taken
 *  together, a box on the canvas, or null for everything. */
export type FlyTarget = string | readonly string[] | Box | null;

export interface CanvasState {
  frames: ReadonlyArray<{ id: string } & Box>;
  /** Tiles' places; a tile with none is not anywhere yet. */
  positions: Readonly<Record<string, { x: number; y: number }>>;
  /** A tile's size, stored or its kind's. */
  sizeOf: (tileId: string) => { width: number; height: number } | undefined;
  objects: readonly BoardObject[];
}

const union = (boxes: Box[]): Box | null => {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

/**
 * The box `target` takes, and whether it is one tile (shown at 100%, where its text is sharp).
 * A drawing's box is all its shapes'; an arrow's is its two ends'; null: nothing of it is placed.
 */
export function boundsOf(state: CanvasState, target: FlyTarget): { box: Box; tile: boolean } | null {
  if (target !== null && typeof target === "object" && !Array.isArray(target)) return { box: target as Box, tile: false };
  const frames = new Map(state.frames.map((f) => [f.id, f]));
  const objects = new Map(state.objects.map((o) => [o.id, o]));
  const boxOf = (id: string, depth = 0): Box[] => {
    const f = frames.get(id);
    if (f) return [{ x: f.x, y: f.y, w: f.w, h: f.h }];
    const p = state.positions[id];
    const size = p ? state.sizeOf(id) : undefined;
    if (p && size) return [{ x: p.x, y: p.y, w: size.width, h: size.height }];
    const o = objects.get(id);
    if (o && isBoardBox(o)) return [{ x: o.x, y: o.y, w: o.w, h: o.h }];
    if (o?.kind === "arrow") return depth > 0 ? [] : [...boxOf(o.from.id, 1), ...boxOf(o.to.id, 1)];
    if (o) return [];
    return state.objects.flatMap((s) => (s.kind === "shape" && s.drawing === id ? boxOf(s.id, depth + 1) : []));
  };
  if (target === null) {
    const everything = [...state.frames.map((f) => f.id), ...Object.keys(state.positions), ...state.objects.map((o) => o.id)];
    const box = union(everything.flatMap((id) => boxOf(id, 1)));
    return box ? { box, tile: false } : null;
  }
  const ids: readonly string[] = typeof target === "string" ? [target] : target;
  const box = union(ids.flatMap((id) => boxOf(id)));
  if (!box) return null;
  const one = ids.length === 1 ? ids[0]! : null;
  return { box, tile: one !== null && !frames.has(one) && state.positions[one] !== undefined };
}
