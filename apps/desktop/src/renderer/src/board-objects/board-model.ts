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
import { isBox as isBoardBox, type BoardChanges } from "@hivemind/workspace-doc/board-actions";
import { facingSides, sidePoint, type Point, type Rect } from "@hivemind/workspace-doc/drawing";
import type { ArrowObject as StoredArrow, BoardObject, ShapeObject, WidgetObject } from "@hivemind/workspace-doc/shapes";
import type { Node } from "@xyflow/react";
import { frameAtPoint } from "../frame-layout";
import type { FrameState } from "../canvas-persistence";

/** A widget placed on the board: it has a box, and moves with its frame, as a note does. */
export type BoardWidget = WidgetObject & { placement: "board"; x: number; y: number; w: number; h: number };
/** What sits on the board in a box: a widget placed there (a note, a checklist and text are widgets), or a shape someone drew. */
export type BoxObject = BoardWidget | ShapeObject;
export type ArrowObject = StoredArrow;
export type BoxKind = BoxObject["kind"];
/** What the Add menu adds: an arrow, or a widget of the package named after `widget:`. */
export type BoardChoice = "arrow" | `widget:${string}`;

export { facingSides, sidePoint };
export type { Point, Rect };

/** What a pointer does on the canvas: select, or draw one of these. */
export const DRAW_TOOLS = [
  "select", "pen", "marker", "rect", "ellipse", "diamond", "triangle", "hexagon", "cylinder", "cloud", "star", "parallelogram",
  "line", "arrow", "text", "eraser", "laser", "note",
] as const;
export type DrawTool = (typeof DRAW_TOOLS)[number];

/** The tools that draw a box of their own name. */
export const BOX_TOOLS = ["rect", "ellipse", "diamond", "triangle", "hexagon", "cylinder", "cloud", "star", "parallelogram"] as const satisfies readonly DrawTool[];
export type BoxTool = (typeof BOX_TOOLS)[number];

export function isBoxTool(tool: DrawTool): tool is BoxTool {
  return (BOX_TOOLS as readonly DrawTool[]).includes(tool);
}

/** The tool in hand, and whether the drawing tools are out: any tool but Select has them out. */
export interface Drawing { tool: DrawTool; on: boolean }

/** `now` with `tool` picked: picking a drawing tool brings the drawing tools out. */
export function pickTool(now: Drawing, tool: DrawTool): Drawing {
  const on = now.on || tool !== "select";
  return tool === now.tool && on === now.on ? now : { tool, on };
}

/** `now` with the drawing tools out or put away: put away, the pointer selects again. */
export function showDrawing(now: Drawing, on: boolean): Drawing {
  const tool = on ? now.tool : "select";
  return tool === now.tool && on === now.on ? now : { tool, on };
}

/** Where a box being drawn from `origin` to `p` is: Shift keeps its sides equal, Alt grows it from its centre. */
export function drawnBox(origin: Point, p: Point, keys: { equal: boolean; centred: boolean }): { from: Point; to: Point } {
  let dx = p.x - origin.x;
  let dy = p.y - origin.y;
  if (keys.equal) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  const to = { x: origin.x + dx, y: origin.y + dy };
  return keys.centred ? { from: { x: origin.x - dx, y: origin.y - dy }, to } : { from: origin, to };
}

const ANGLE_STEP = Math.PI / 12;

/** `to` turned about `from` to the nearest 15 degrees, as far away as it was. */
export function snappedEnd(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / ANGLE_STEP) * ANGLE_STEP;
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

/** The smallest a resize leaves a box. */
export const BOX_SIZE: Record<BoxKind, { minW: number; minH: number }> = {
  widget: { minW: 80, minH: 36 },
  shape: { minW: 8, minH: 8 },
};

/** The widgets floating over the view `view` (not placed on the board), oldest first: those over
 *  every view, and those `view` brought. One another view brought waits for that view. */
export function widgetsOf(board: BoardObject[], view: string | null): WidgetObject[] {
  return board.filter((o): o is WidgetObject => o.kind === "widget" && o.placement !== "board" && (o.view === undefined || o.view === view))
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `o` shown over every view: a widget a view brought no longer waits for that view (its card's
 *  pin, `hive ctl plugin open <its id>`). Anything else, as it is. */
export function onEveryView(o: BoardObject): BoardObject {
  if (o.kind !== "widget" || o.view === undefined) return o;
  const { view: _brought, ...everywhere } = o;
  return everywhere;
}

/** What a view brings of its package's switched-on widgets (`members`, in the package's order) to a
 *  workspace that holds `onBoard` and was brought `brought` before: those to add, and those now
 *  counted as brought. One already on the board is brought without a second copy; one brought
 *  before is never brought again, closed or not. A workspace never brought any of them that holds
 *  some is one the person arranged by hand: nothing is added to it. */
export function widgetsToBring(members: readonly string[], onBoard: readonly string[], brought: readonly string[]): { add: string[]; brought: string[] } {
  const fresh = members.filter((id) => !brought.includes(id));
  const arranged = fresh.length === members.length && members.some((id) => onBoard.includes(id));
  return { add: arranged ? [] : fresh.filter((id) => !onBoard.includes(id)), brought: fresh };
}

export function isBox(o: BoardObject): o is BoxObject {
  return isBoardBox(o);
}

/** Whether a shape is painted with the rest of what is drawn (DrawnLayer) rather than drawn as its
 *  own node: one with writing is a node, for its text. */
export function paintedHere(o: ShapeObject): boolean {
  return !o.text && o.form !== "text" && o.form !== "image";
}

/** What is selected on the board and what is written in. */
export interface Selection { selectedId: string | null; selectedIds: readonly string[]; editingId: string | null }

/** `chosen` without what `board` no longer has, as another writer or an undo left it; `chosen`
 *  itself when it is all still there. */
export function selectionOn(board: readonly BoardObject[], chosen: Selection): Selection {
  if (chosen.selectedId === null && chosen.selectedIds.length === 0 && chosen.editingId === null) return chosen;
  const here = new Set(board.map((o) => o.id));
  const selectedIds = chosen.selectedIds.every((id) => here.has(id)) ? chosen.selectedIds : chosen.selectedIds.filter((id) => here.has(id));
  const selectedId = chosen.selectedId !== null && here.has(chosen.selectedId) ? chosen.selectedId : selectedIds[0] ?? null;
  const editingId = chosen.editingId !== null && here.has(chosen.editingId) ? chosen.editingId : null;
  if (selectedIds === chosen.selectedIds && selectedId === chosen.selectedId && editingId === chosen.editingId) return chosen;
  return { selectedId, selectedIds, editingId };
}

/** How many painted shapes a selection shows as their nodes, with handles; past it they stay painted
 *  and the painted layer marks them. */
export const SHOWN_SELECTED_MOST = 64;

/** `nodes` with those in `chosen` marked selected and drawn on top. A frame keeps its own place. */
export function withSelected(nodes: Node[], chosen: ReadonlySet<string>): Node[] {
  let painted = 0;
  if (chosen.size > SHOWN_SELECTED_MOST) for (const n of nodes) if (n.hidden && chosen.has(n.id)) painted++;
  const showPainted = painted <= SHOWN_SELECTED_MOST;
  return nodes.map((n) => {
    if (n.type === "frame" || !chosen.has(n.id)) return n;
    if (n.hidden && !showPainted) return { ...n, selected: true };
    return { ...n, selected: true, hidden: false, style: { ...(n.style ?? {}), zIndex: 1000 } };
  });
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

/** `now` with each object that changed nothing kept as the one in `before`, and `before` itself when
 *  nothing changed: an edit is then found by identity, never by reading the whole board. */
export function keepUnchanged(before: readonly BoardObject[], now: BoardObject[]): BoardObject[] {
  const was = new Map(before.map((o) => [o.id, o]));
  let same = before.length === now.length;
  const kept = now.map((o, i) => {
    const old = was.get(o.id);
    const keep = old !== undefined && (old === o || sameFields(old, o)) ? old : o;
    if (keep !== before[i]) same = false;
    return keep;
  });
  return same ? (before as BoardObject[]) : kept;
}

function sameFields(a: BoardObject, b: BoardObject): boolean {
  const keys = Object.keys(a) as (keyof BoardObject)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
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

/** `board` with what a board action answered: each changed object in its place, those taken away
 *  gone, new ones at the end; `board` itself when nothing changed. */
export function withChanges(board: BoardObject[], changes: BoardChanges): BoardObject[] {
  const ids = Object.keys(changes);
  if (ids.length === 0) return board;
  const left = new Set(ids);
  const next: BoardObject[] = [];
  for (const o of board) {
    if (!left.has(o.id)) { next.push(o); continue; }
    left.delete(o.id);
    const now = changes[o.id];
    if (now) next.push(now);
  }
  for (const id of left) {
    const added = changes[id];
    if (added) next.push(added);
  }
  return next;
}

/** The shapes of the drawing `id` is part of, by id: `id` alone when it is in none. */
export function groupOf(board: readonly BoardObject[], id: string): string[] {
  const o = board.find((x) => x.id === id);
  if (o?.kind !== "shape" || !o.drawing) return [id];
  return board.filter((x) => x.kind === "shape" && x.drawing === o.drawing).map((x) => x.id);
}

/** The board without `id`, and without any arrow that ends on it. */
export function withoutObject(board: BoardObject[], id: string): BoardObject[] {
  return board.filter((o) => o.id !== id && !(o.kind === "arrow" && (o.from.id === id || o.to.id === id)));
}

/** The next stacking order: in front of everything on the board. */
export function frontZ(board: BoardObject[]): number {
  return board.reduce((z, o) => Math.max(z, o.z ?? 0), 0) + 1;
}

/** The first of `frontToBack` a point is in: what a click there lands on. */
export function hitTest<T extends { rect: Rect }>(p: Point, frontToBack: T[]): T | undefined {
  return frontToBack.find(({ rect: r }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
}
