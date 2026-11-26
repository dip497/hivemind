/**
 * useBoard — the board's state in a window (docs/design/multiplayer-2026-09-28.md, R15): its
 * objects on the canvas, the one selected and the one being written in, and an arrow being drawn.
 * It loads a workspace's board with that workspace's frames, saves it through the store the way
 * every layout is saved (debounced, flushed on a repo switch and on unload), and asks the store
 * to undo and redo board edits. What an edit does to the board is board-model's; this holds it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";
import { rebaseBoard } from "@hivemind/workspace-doc/rebase";
import { boundsOf, scaledPoints } from "@hivemind/workspace-doc/drawing";
import {
  alignObjects, duplicateObjects, isLocked, lockObjects, moveObjects, restack, styleObjects,
  type AlignHow, type BoardChanges, type FrameAt, type ObjectStyle,
} from "@hivemind/workspace-doc/board-actions";
import type { BoardObject, ShapeColor, ShapeObject } from "@hivemind/workspace-doc/shapes";
import { mintId } from "@hivemind/workspace-api/tile-id";
import type { FrameState } from "../canvas-persistence";
import { snapToGrid } from "../canvas-sizing";
import { useDebouncedSave } from "../workspace/view-layout-store";
import { readBoard, redoBoard, rereadBoard, undoBoard, writeBoard } from "../workspace/workspace-store-client";
import {
  facingSides, frameAt, frontZ, groupOf, isBox, keepUnchanged, newWidget, toCanvas, toStored, withChanges, withoutObject,
  pickTool, selectionOn, showDrawing, type Drawing, type DrawTool, type Point, type Rect, type Selection,
} from "./board-model";

/** Something an arrow can end on: a tile, frame or board object, and where it is on the canvas. */
export interface ArrowTarget {
  id: string;
  rect: Rect;
}

export interface Board {
  /** The workspace whose board this is: what its pictures are fetched from. */
  repo: string | null;
  objects: BoardObject[];
  /** The newest board, rendered or not, for handlers that act on it at once (arrange, placing a tile). */
  objectsRef: MutableRefObject<BoardObject[]>;
  selectedId: string | null;
  /** Everything selected: the one selected, the drawing it is part of, or what a drag took in. */
  selectedIds: readonly string[];
  /** What the pointer does on the canvas, and the colour and fill a new shape takes. */
  tool: DrawTool;
  setTool: (tool: DrawTool) => void;
  /** The drawing tools are out, in the tool island. */
  drawing: boolean;
  setDrawing: (on: boolean) => void;
  ink: ShapeColor;
  setInk: (ink: ShapeColor) => void;
  filled: boolean;
  setFilled: (filled: boolean) => void;
  /** The object whose text is being written in. */
  editingId: string | null;
  /** An arrow being drawn: null until its start is picked. Undefined when none is. */
  arrowFrom: ArrowTarget | null | undefined;
  select: (id: string | null) => void;
  /** Select all of these, as a drag across the canvas took them in. */
  selectMany: (ids: readonly string[]) => void;
  edit: (id: string | null) => void;
  /** Draw a shape, in canvas coordinates: it joins the frame its centre is in. Its new id. */
  addShape: (shape: Omit<ShapeObject, "id" | "kind" | "z">, then?: "select" | "edit") => string;
  /** An arrow from one thing on the canvas to another. */
  addArrow: (from: ArrowTarget, to: ArrowTarget) => void;
  removeSelected: () => void;
  duplicateSelected: () => void;
  /** Add a widget of the package `pkg`: on the board at `board.at`, else floating over every view. */
  /** The new widget's id. */
  addWidget: (pkg: string, board?: { at: Point; size: { w: number; h: number }; lines?: boolean }) => string;
  /** Widgets the app brings (a package's view), floating over that view alone, saved at once as an
   *  edit of their own: never taken back by the same undo as the person's last edit. */
  bringWidgets: (pkgs: readonly string[], view: string) => void;
  /** Put back an object taken away, as it was: a widget with its options and what it keeps. */
  restore: (object: BoardObject) => void;
  update: (id: string, change: (o: BoardObject) => BoardObject) => void;
  /** Take these objects away, in one edit: one undo puts them all back. */
  remove: (...ids: string[]) => void;
  duplicate: (id: string) => void;
  /** Copies of these, moved by `dx`, `dy`, selected: in one edit, each in the frame its centre is in. */
  duplicateBy: (ids: readonly string[], dx: number, dy: number) => void;
  /** Boxes dropped on the canvas, each at its own place, in one edit: each joins the frame its centre is in, or none. */
  moveTo: (places: ReadonlyMap<string, Point>) => void;
  resize: (id: string, w: number, h: number, x?: number, y?: number) => void;
  /** Change the look of these shapes and arrows, in one edit. */
  setStyle: (ids: readonly string[], change: ObjectStyle) => void;
  /** Lock or unlock these shapes: a locked one is not moved, resized or erased. */
  lock: (ids: readonly string[], locked: boolean) => void;
  /** In front of, or behind, everything else on the board, keeping their own order. */
  toFront: (ids: readonly string[]) => void;
  toBack: (ids: readonly string[]) => void;
  align: (ids: readonly string[], how: AlignHow) => void;
  nudge: (ids: readonly string[], dx: number, dy: number) => void;
  /** Select every shape drawn on the canvas now. */
  selectAll: () => void;
  /** Keep what is selected to paste, here or in another workspace of this window. */
  copy: () => void;
  /** Paste what was copied: below and right of where it was, or with its corner at `at`. */
  paste: (at?: Point) => void;
  /** Move the boxes in these frames with them. */
  shiftFrames: (shifts: ReadonlyMap<string, { dx: number; dy: number }>) => void;
  /** Put boxes where an arrange placed them (canvas coordinates). */
  place: (positions: Readonly<Record<string, Point>>) => void;
  startArrow: () => void;
  pickArrowEnd: (target: ArrowTarget) => void;
  cancelArrow: () => void;
  undo: () => void;
  redo: () => void;
  /** Show another workspace's board, placed by that workspace's frames. */
  reload: (persistKey: string | null, frames: FrameState[]) => void;
  /** Another writer changed this board (another window): take it as stored (`objects`: those
   *  alone changed), keeping what this window changed since it last read or wrote. */
  merge: (objects?: readonly string[]) => void;
}

/**
 * Another writer changed `repo`'s board: the board as stored, as an update of the window's own (in
 * canvas coordinates, placed by `frames`), which keeps what the window changed since it last read
 * or wrote, as `reloadLayout` does the core.
 */
export function reloadBoardObjects(repo: string, frames: FrameState[], objects?: readonly string[]): (mine: BoardObject[]) => BoardObject[] {
  const { base, board } = rereadBoard(repo, objects);
  return (mine) => toCanvas(rebaseBoard(base, toStored(mine, frames), board), frames);
}

const NOTHING: readonly string[] = [];
const INK_KEY = "hivemind:draw-ink";
const DRAWING_KEY = "hivemind:drawing";

export function useBoard({ persistKey, frames, framesRef, focusRef, onSelect }: {
  persistKey: string | null;
  frames: FrameState[];
  framesRef: MutableRefObject<FrameState[]>;
  /** The frame the window is inside and every frame in it; null: the whole canvas. Select-all and
   *  a new widget's free spot look only there. */
  focusRef: MutableRefObject<ReadonlySet<string> | null>;
  /** An object was selected: whatever tile was selected is not any more. */
  onSelect: () => void;
}): Board {
  const [objects, setObjects] = useState<BoardObject[]>(() => (persistKey ? toCanvas(readBoard(persistKey), frames) : []));
  // The newest board asked for, rendered or not: an edit and an undo in one handler both see it.
  const latest = useRef(objects);
  const set = useCallback((next: (board: BoardObject[]) => BoardObject[]) => {
    const board = next(latest.current);
    if (board === latest.current) return;
    latest.current = board;
    setObjects(board);
  }, []);
  /** One edit of what a board action answered. */
  const apply = useCallback((changes: BoardChanges) => set((board) => withChanges(board, changes)), [set]);
  const frameNow = useCallback<FrameAt>((centre) => frameAt(framesRef.current, centre), [framesRef]);
  const inFocus = useCallback((o: BoardObject) => {
    const members = focusRef.current;
    return !members || (o.kind !== "arrow" && o.frame !== undefined && members.has(o.frame));
  }, [focusRef]);

  // Saved as the store keeps it, and only when that changed: a frame moving its boxes along
  // changes nothing there.
  const storedRef = useRef<BoardObject[]>([]);
  const stored = useMemo(() => (storedRef.current = keepUnchanged(storedRef.current, toStored(objects, frames))), [objects, frames]);
  const { flush } = useDebouncedSave(persistKey, stored, useCallback((key: string, board: BoardObject[]) => writeBoard(key, board), []));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(NOTHING);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const [editingId, setEditingId] = useState<string | null>(null);
  const chosenRef = useRef<Selection>({ selectedId, selectedIds, editingId });
  chosenRef.current = { selectedId, selectedIds, editingId };
  /** A board this window did not edit itself: what is selected or written in and gone is let go. */
  const forgetGone = useCallback((board: readonly BoardObject[]) => {
    const now = chosenRef.current;
    const left = selectionOn(board, now);
    if (left === now) return;
    setSelectedId(left.selectedId);
    setSelectedIds(left.selectedIds.length ? left.selectedIds : NOTHING);
    setEditingId(left.editingId);
  }, []);
  const [{ tool, on: drawing }, setPointer] = useState<Drawing>(() => {
    try { return { tool: "select", on: localStorage.getItem(DRAWING_KEY) === "on" }; } catch { return { tool: "select", on: false }; }
  });
  const [ink, setInkState] = useState<ShapeColor>(() => {
    try { return (localStorage.getItem(INK_KEY) as ShapeColor | null) ?? "ink"; } catch { return "ink"; }
  });
  const setInk = useCallback((next: ShapeColor) => {
    setInkState(next);
    try { localStorage.setItem(INK_KEY, next); } catch { /* it is only a preference */ }
  }, []);
  const [filled, setFilled] = useState(false);
  const [arrowFrom, setArrowFrom] = useState<ArrowTarget | null | undefined>(undefined);
  const arrowFromRef = useRef(arrowFrom);
  arrowFromRef.current = arrowFrom;

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedIds(id ? groupOf(latest.current, id) : NOTHING);
    setEditingId((cur) => (cur === id ? cur : null));
    if (id) onSelect();
  }, [onSelect]);
  const selectMany = useCallback((ids: readonly string[]) => {
    setSelectedId(ids[0] ?? null);
    setSelectedIds(ids.length ? ids : NOTHING);
    setEditingId(null);
    if (ids.length) onSelect();
  }, [onSelect]);
  const editingRef = useRef<string | null>(null);
  const edit = useCallback((id: string | null) => {
    // Text left with nothing written is not kept.
    const left = latest.current.find((o) => o.id === editingRef.current);
    editingRef.current = id;
    if (left?.kind === "shape" && left.form === "text" && !left.text?.trim() && left.id !== id) {
      set((board) => withoutObject(board, left.id));
      setSelectedId((cur) => (cur === left.id ? null : cur));
      setSelectedIds((cur) => (cur.includes(left.id) ? cur.filter((x) => x !== left.id) : cur));
    }
    setEditingId(id);
    if (id) { setSelectedId(id); setSelectedIds([id]); onSelect(); }
  }, [onSelect, set]);
  useEffect(() => {
    try { localStorage.setItem(DRAWING_KEY, drawing ? "on" : "off"); } catch { /* it is only a preference */ }
  }, [drawing]);
  const setDrawing = useCallback((on: boolean) => { setPointer((now) => showDrawing(now, on)); }, []);
  const setTool = useCallback((next: DrawTool) => {
    setPointer((now) => pickTool(now, next));
    if (next === "select") return;
    // Letters are tools now: nothing selected or focused takes them as typing.
    setSelectedId(null);
    setSelectedIds(NOTHING);
    setEditingId(null);
    setArrowFrom(undefined);
    onSelect();
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, [onSelect]);

  const update = useCallback((id: string, change: (o: BoardObject) => BoardObject) => {
    set((board) => {
      let changed = false;
      const next = board.map((o) => {
        if (o.id !== id) return o;
        const n = change(o);
        if (n !== o) changed = true;
        return n;
      });
      return changed ? next : board;
    });
  }, [set]);

  const addWidget = useCallback((pkg: string, place?: { at: Point; size: { w: number; h: number }; lines?: boolean }) => {
    // Never on top of another's corner: one step down and right while another starts within a step,
    // so the one under it can still be seen and written in.
    let at = place?.at;
    if (place && at) {
      const STEP = 24;
      const taken = (p: Point) => latest.current.some((o) => isBox(o) && inFocus(o)
        && Math.abs(o.x - (p.x - place.size.w / 2)) < STEP && Math.abs(o.y - (p.y - place.size.h / 2)) < STEP);
      for (let i = 0; i < 20 && taken(at); i++) at = { x: at.x + STEP, y: at.y + STEP };
    }
    const w = newWidget(pkg, mintId("widget"), frontZ(latest.current), place && at ? { ...place, at, frames: framesRef.current } : undefined);
    set((board) => [...board, w]);
    // On the board it is written in at once, as a new note is.
    if (place) edit(w.id);
    return w.id;
  }, [set, edit, framesRef, inFocus]);


  const bringWidgets = useCallback((pkgs: readonly string[], view: string) => {
    if (!pkgs.length) return;
    // What the person did is saved first, as its own step.
    flush();
    let z = frontZ(latest.current);
    const brought = pkgs.map((pkg) => ({ ...newWidget(pkg, mintId("widget"), z++), view }));
    set((board) => [...board, ...brought]);
    if (persistKey) writeBoard(persistKey, toStored(latest.current, framesRef.current));
  }, [persistKey, flush, set, framesRef]);

  const remove = useCallback((...asked: string[]) => {
    const locked = new Set(latest.current.filter(isLocked).map((o) => o.id));
    const ids = asked.filter((id) => !locked.has(id));
    if (ids.length === 0) return;
    set((board) => ids.reduce((left, id) => withoutObject(left, id), board));
    setSelectedId((cur) => (cur !== null && ids.includes(cur) ? null : cur));
    setSelectedIds((cur) => (cur.some((x) => ids.includes(x)) ? cur.filter((x) => !ids.includes(x)) : cur));
    setEditingId((cur) => (cur !== null && ids.includes(cur) ? null : cur));
  }, [set]);

  const removeSelected = useCallback(() => remove(...selectedIdsRef.current), [remove]);

  const addShape = useCallback((shape: Omit<ShapeObject, "id" | "kind" | "z">, then?: "select" | "edit") => {
    const frame = frameNow({ x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 });
    const id = mintId("shape");
    set((board) => [...board, { ...shape, id, kind: "shape", z: frontZ(board), ...(frame ? { frame } : {}) }]);
    if (then === "edit") edit(id);
    else if (then === "select") select(id);
    return id;
  }, [set, edit, select, frameNow]);

  const restore = useCallback((object: BoardObject) => {
    set((board) => (board.some((o) => o.id === object.id) ? board : [...board, object]));
  }, [set]);

  /** Copies of `ids` as `source` has them, moved by `dx`, `dy`, selected: one edit. `reframe`: each
   *  joins the frame its centre lands in. Refused with a toast when the board would hold too many shapes. */
  const copyOf = useCallback((source: readonly BoardObject[], ids: readonly string[], dx: number, dy: number, reframe: boolean) => {
    let copies: BoardChanges;
    try {
      copies = duplicateObjects(source, ids, mintId, dx, dy);
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    const made = Object.values(copies).filter((o): o is BoardObject => o !== null);
    const boxes = made.filter(isBox);
    const corner = boundsOf(boxes);
    if (!corner) return;
    apply(reframe ? { ...copies, ...moveObjects(made, boxes.map((o) => o.id), corner, frameNow) } : copies);
    selectMany(boxes.map((o) => o.id));
  }, [apply, frameNow, selectMany]);

  const duplicateSelected = useCallback(() => copyOf(latest.current, selectedIdsRef.current, 24, 24, false), [copyOf]);
  const duplicate = useCallback((id: string) => copyOf(latest.current, [id], 24, 24, false), [copyOf]);
  const duplicateBy = useCallback((ids: readonly string[], dx: number, dy: number) => copyOf(latest.current, ids, dx, dy, true), [copyOf]);

  const moveTo = useCallback((places: ReadonlyMap<string, Point>) => {
    const changes: BoardChanges = {};
    for (const o of latest.current) {
      const at = places.get(o.id);
      if (!at) continue;
      // What is drawn lands where it was let go: a stroke round something stays round it, and a
      // drawing moved whole keeps its shape.
      const to = o.kind === "shape" ? at : { x: snapToGrid(at.x), y: snapToGrid(at.y) };
      Object.assign(changes, moveObjects([o], [o.id], to, frameNow));
    }
    apply(changes);
  }, [apply, frameNow]);

  const resize = useCallback((id: string, w: number, h: number, x?: number, y?: number) => {
    update(id, (o) => {
      if (!isBox(o) || isLocked(o)) return o;
      // The resizer reports x and y relative to the frame the node is drawn in.
      const frame = o.frame ? framesRef.current.find((f) => f.id === o.frame) : undefined;
      const nx = x === undefined ? o.x : x + (frame?.x ?? 0);
      const ny = y === undefined ? o.y : y + (frame?.y ?? 0);
      if (w === o.w && h === o.h && nx === o.x && ny === o.y) return o;
      if (o.kind === "shape" && o.points) return { ...o, w, h, x: nx, y: ny, points: scaledPoints(o.points, o, { w, h }) };
      return { ...o, w, h, x: nx, y: ny };
    });
  }, [update, framesRef]);

  const setStyle = useCallback((ids: readonly string[], change: ObjectStyle) => apply(styleObjects(latest.current, ids, change)), [apply]);
  const lock = useCallback((ids: readonly string[], locked: boolean) => apply(lockObjects(latest.current, ids, locked)), [apply]);
  const toFront = useCallback((ids: readonly string[]) => apply(restack(latest.current, ids, "front")), [apply]);
  const toBack = useCallback((ids: readonly string[]) => apply(restack(latest.current, ids, "back")), [apply]);
  const align = useCallback((ids: readonly string[], how: AlignHow) => apply(alignObjects(latest.current, ids, how, frameNow)), [apply, frameNow]);

  const nudge = useCallback((ids: readonly string[], dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    // moveObjects places the corner of what it moves: the boxes that are not locked.
    const chosen = new Set(ids);
    const from = boundsOf(latest.current.filter((o) => chosen.has(o.id) && isBox(o) && !isLocked(o)) as Rect[]);
    if (from) apply(moveObjects(latest.current, ids, { x: from.x + dx, y: from.y + dy }, frameNow));
  }, [apply, frameNow]);

  const selectAll = useCallback(() => {
    selectMany(latest.current.filter((o) => o.kind === "shape" && inFocus(o)).map((o) => o.id));
  }, [selectMany, inFocus]);

  // What was copied, as it was then, and how many times it has been pasted since.
  const copied = useRef<{ objects: BoardObject[]; pasted: number }>({ objects: [], pasted: 0 });
  const copy = useCallback(() => {
    const chosen = new Set(selectedIdsRef.current);
    const objects = latest.current.filter((o) => (o.kind === "arrow" ? chosen.has(o.from.id) && chosen.has(o.to.id) : chosen.has(o.id)));
    if (objects.some(isBox)) copied.current = { objects, pasted: 0 };
  }, []);
  const paste = useCallback((at?: Point) => {
    const kept = copied.current;
    const boxes = kept.objects.filter(isBox);
    if (boxes.length === 0) return;
    kept.pasted += 1;
    // Each paste after the first goes one step further below and right.
    const corner = boundsOf(boxes)!;
    const [dx, dy] = at ? [at.x - corner.x, at.y - corner.y] : [24 * kept.pasted, 24 * kept.pasted];
    // As copied, on this board: counted against its shapes and put in front of everything on it.
    const copiedIds = new Set(kept.objects.map((o) => o.id));
    const source = [...latest.current.filter((o) => !copiedIds.has(o.id)), ...kept.objects];
    copyOf(source, boxes.map((o) => o.id), dx, dy, true);
  }, [copyOf]);

  const shiftFrames = useCallback((shifts: ReadonlyMap<string, { dx: number; dy: number }>) => {
    set((board) => {
      let changed = false;
      const next = board.map((o) => {
        const d = isBox(o) && o.frame ? shifts.get(o.frame) : undefined;
        if (!d || !isBox(o) || (d.dx === 0 && d.dy === 0)) return o;
        changed = true;
        return { ...o, x: o.x + d.dx, y: o.y + d.dy };
      });
      return changed ? next : board;
    });
  }, [set]);

  const place = useCallback((positions: Readonly<Record<string, Point>>) => {
    set((board) => {
      let changed = false;
      const next = board.map((o) => {
        const p = positions[o.id];
        if (!p || !isBox(o) || (p.x === o.x && p.y === o.y)) return o;
        changed = true;
        return { ...o, x: p.x, y: p.y };
      });
      return changed ? next : board;
    });
  }, [set]);

  const startArrow = useCallback(() => {
    setArrowFrom(null);
    setSelectedId(null);
    setSelectedIds(NOTHING);
    setEditingId(null);
  }, []);
  const addArrow = useCallback((from: ArrowTarget, to: ArrowTarget, color?: ShapeColor) => {
    const [fromSide, toSide] = facingSides(from.rect, to.rect);
    const arrow: BoardObject = {
      id: mintId("arrow"), kind: "arrow", label: "", z: frontZ(latest.current),
      from: { id: from.id, side: fromSide }, to: { id: to.id, side: toSide }, ...(color && color !== "ink" ? { color } : {}),
    };
    set((board) => [...board, arrow]);
    select(arrow.id);
  }, [set, select]);
  const cancelArrow = useCallback(() => setArrowFrom(undefined), []);
  const pickArrowEnd = useCallback((target: ArrowTarget) => {
    const from = arrowFromRef.current;
    if (from === undefined) return;
    if (from === null) { setArrowFrom(target); return; }
    if (from.id === target.id) return;
    addArrow(from, target);
    setArrowFrom(undefined);
  }, [addArrow]);

  // The store's history is of what it was sent: send the board as it is now first, even an
  // edit made in this very handler, then show what the store holds after.
  const history = useCallback((step: (key: string) => boolean) => {
    if (!persistKey) return;
    flush();
    writeBoard(persistKey, toStored(latest.current, framesRef.current));
    if (!step(persistKey)) return;
    const board = toCanvas(readBoard(persistKey), framesRef.current);
    latest.current = board;
    setObjects(board);
    forgetGone(board);
  }, [persistKey, flush, framesRef, forgetGone]);
  const undo = useCallback(() => history(undoBoard), [history]);
  const redo = useCallback(() => history(redoBoard), [history]);

  // What this window has yet to save is written first, so its base is what it last wrote.
  const merge = useCallback((objects?: readonly string[]) => {
    if (!persistKey) return;
    flush();
    set(reloadBoardObjects(persistKey, framesRef.current, objects));
    forgetGone(latest.current);
  }, [persistKey, flush, set, framesRef, forgetGone]);

  const reload = useCallback((key: string | null, nextFrames: FrameState[]) => {
    const board = key ? toCanvas(readBoard(key), nextFrames) : [];
    latest.current = board;
    setObjects(board);
    setSelectedId(null);
    setSelectedIds(NOTHING);
    setEditingId(null);
    setArrowFrom(undefined);
    setPointer((now) => pickTool(now, "select"));
  }, []);

  return useMemo(() => ({
    repo: persistKey, objects, objectsRef: latest, selectedId, selectedIds, editingId, arrowFrom, tool, setTool, drawing, setDrawing, ink, setInk, filled, setFilled,
    select, selectMany, edit, addShape, addArrow, removeSelected, duplicateSelected, duplicateBy,
    addWidget, bringWidgets, update, remove, restore, duplicate, moveTo, resize, shiftFrames, place,
    setStyle, lock, toFront, toBack, align, nudge, selectAll, copy, paste,
    startArrow, pickArrowEnd, cancelArrow, undo, redo, reload, merge,
  }), [
    persistKey, objects, selectedId, selectedIds, editingId, arrowFrom, tool, setTool, drawing, setDrawing, ink, setInk, filled, setFilled,
    select, selectMany, edit, addShape, addArrow, removeSelected, duplicateSelected, duplicateBy,
    addWidget, bringWidgets, update, remove, restore, duplicate, moveTo, resize, shiftFrames, place,
    setStyle, lock, toFront, toBack, align, nudge, selectAll, copy, paste,
    startArrow, pickArrowEnd, cancelArrow, undo, redo, reload, merge,
  ]);
}
