/**
 * useBoard — the board's state in a window (docs/design/multiplayer-2026-09-28.md, R15): its
 * objects on the canvas, the one selected and the one being written in, and an arrow being drawn.
 * It loads a workspace's board with that workspace's frames, saves it through the store the way
 * every layout is saved (debounced, flushed on a repo switch and on unload), and asks the store
 * to undo and redo board edits. What an edit does to the board is board-model's; this holds it.
 */
import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { rebaseBoard } from "@hivemind/workspace-doc/rebase";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import { mintId } from "@hivemind/workspace-api/tile-id";
import type { FrameState } from "../canvas-persistence";
import { snapToGrid } from "../canvas-sizing";
import { useDebouncedSave } from "../workspace/view-layout-store";
import { readBoard, redoBoard, rereadBoard, undoBoard, writeBoard } from "../workspace/workspace-store-client";
import {
  duplicateBox, facingSides, frameAt, frontZ, isBox, newBox, toCanvas, toStored, withoutObject,
  type BoxKind, type Point, type Rect,
} from "./board-model";

/** Something an arrow can end on: a tile, frame or board object, and where it is on the canvas. */
export interface ArrowTarget {
  id: string;
  rect: Rect;
}

export interface Board {
  objects: BoardObject[];
  /** The newest board, rendered or not, for handlers that act on it at once (arrange, placing a tile). */
  objectsRef: MutableRefObject<BoardObject[]>;
  selectedId: string | null;
  /** The object whose text is being written in. */
  editingId: string | null;
  /** An arrow being drawn: null until its start is picked. Undefined when none is. */
  arrowFrom: ArrowTarget | null | undefined;
  select: (id: string | null) => void;
  edit: (id: string | null) => void;
  add: (kind: BoxKind, at: Point) => void;
  update: (id: string, change: (o: BoardObject) => BoardObject) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  /** A box dropped at `x`, `y` on the canvas: it joins the frame its centre is in, or none. */
  moveTo: (id: string, x: number, y: number) => void;
  resize: (id: string, w: number, h: number, x?: number, y?: number) => void;
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
  /** Another writer changed this board (another window): take it as stored, keeping what this
   *  window changed since it last read or wrote. */
  merge: () => void;
}

/**
 * Another writer changed `repo`'s board: the board as stored, as an update of the window's own (in
 * canvas coordinates, placed by `frames`), which keeps what the window changed since it last read
 * or wrote, as `reloadLayout` does the core.
 */
export function reloadBoardObjects(repo: string, frames: FrameState[]): (mine: BoardObject[]) => BoardObject[] {
  const { base, board } = rereadBoard(repo);
  return (mine) => toCanvas(rebaseBoard(base, toStored(mine, frames), board), frames);
}

export function useBoard({ persistKey, frames, framesRef, onSelect }: {
  persistKey: string | null;
  frames: FrameState[];
  framesRef: MutableRefObject<FrameState[]>;
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

  // Saved as the store keeps it, and only when that changed: a frame moving its boxes along
  // changes nothing there.
  const storedRef = useRef<{ json: string; board: BoardObject[] } | null>(null);
  const stored = useMemo(() => {
    const board = toStored(objects, frames);
    const json = JSON.stringify(board);
    if (storedRef.current?.json !== json) storedRef.current = { json, board };
    return storedRef.current.board;
  }, [objects, frames]);
  const { flush } = useDebouncedSave(persistKey, stored, useCallback((key: string, board: BoardObject[]) => writeBoard(key, board), []));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [arrowFrom, setArrowFrom] = useState<ArrowTarget | null | undefined>(undefined);
  const arrowFromRef = useRef(arrowFrom);
  arrowFromRef.current = arrowFrom;

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setEditingId((cur) => (cur === id ? cur : null));
    if (id) onSelect();
  }, [onSelect]);
  const edit = useCallback((id: string | null) => {
    setEditingId(id);
    if (id) { setSelectedId(id); onSelect(); }
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

  const add = useCallback((kind: BoxKind, at: Point) => {
    const box = newBox(kind, mintId(kind), at, framesRef.current, frontZ(latest.current));
    set((board) => [...board, box]);
    edit(box.id);
  }, [set, edit, framesRef]);

  const remove = useCallback((id: string) => {
    set((board) => withoutObject(board, id));
    setSelectedId((cur) => (cur === id ? null : cur));
    setEditingId((cur) => (cur === id ? null : cur));
  }, [set]);

  const duplicate = useCallback((id: string) => {
    const o = latest.current.find((x) => x.id === id);
    if (!o || !isBox(o)) return;
    const copy = duplicateBox(o, mintId(o.kind), frontZ(latest.current), () => mintId("item"));
    set((board) => [...board, copy]);
    select(copy.id);
  }, [set, select]);

  const moveTo = useCallback((id: string, x: number, y: number) => {
    update(id, (o) => {
      if (!isBox(o)) return o;
      const nx = snapToGrid(x);
      const ny = snapToGrid(y);
      const frame = frameAt(framesRef.current, { x: nx + o.w / 2, y: ny + o.h / 2 });
      if (nx === o.x && ny === o.y && frame === o.frame) return o;
      const { frame: _was, ...rest } = o;
      return { ...rest, x: nx, y: ny, ...(frame ? { frame } : {}) };
    });
  }, [update, framesRef]);

  const resize = useCallback((id: string, w: number, h: number, x?: number, y?: number) => {
    update(id, (o) => {
      if (!isBox(o)) return o;
      // The resizer reports x and y relative to the frame the node is drawn in.
      const frame = o.frame ? framesRef.current.find((f) => f.id === o.frame) : undefined;
      const nx = x === undefined ? o.x : x + (frame?.x ?? 0);
      const ny = y === undefined ? o.y : y + (frame?.y ?? 0);
      if (w === o.w && h === o.h && nx === o.x && ny === o.y) return o;
      return { ...o, w, h, x: nx, y: ny };
    });
  }, [update, framesRef]);

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
    setEditingId(null);
  }, []);
  const cancelArrow = useCallback(() => setArrowFrom(undefined), []);
  const pickArrowEnd = useCallback((target: ArrowTarget) => {
    const from = arrowFromRef.current;
    if (from === undefined) return;
    if (from === null) { setArrowFrom(target); return; }
    if (from.id === target.id) return;
    const [fromSide, toSide] = facingSides(from.rect, target.rect);
    const arrow: BoardObject = {
      id: mintId("arrow"), kind: "arrow", label: "", z: frontZ(latest.current),
      from: { id: from.id, side: fromSide }, to: { id: target.id, side: toSide },
    };
    set((board) => [...board, arrow]);
    setArrowFrom(undefined);
    select(arrow.id);
  }, [set, select]);

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
  }, [persistKey, flush, framesRef]);
  const undo = useCallback(() => history(undoBoard), [history]);
  const redo = useCallback(() => history(redoBoard), [history]);

  // What this window has yet to save is written first, so its base is what it last wrote.
  const merge = useCallback(() => {
    if (!persistKey) return;
    flush();
    set(reloadBoardObjects(persistKey, framesRef.current));
  }, [persistKey, flush, set, framesRef]);

  const reload = useCallback((key: string | null, nextFrames: FrameState[]) => {
    const board = key ? toCanvas(readBoard(key), nextFrames) : [];
    latest.current = board;
    setObjects(board);
    setSelectedId(null);
    setEditingId(null);
    setArrowFrom(undefined);
  }, []);

  return useMemo(() => ({
    objects, objectsRef: latest, selectedId, editingId, arrowFrom,
    select, edit, add, update, remove, duplicate, moveTo, resize, shiftFrames, place,
    startArrow, pickArrowEnd, cancelArrow, undo, redo, reload, merge,
  }), [
    objects, selectedId, editingId, arrowFrom,
    select, edit, add, update, remove, duplicate, moveTo, resize, shiftFrames, place,
    startArrow, pickArrowEnd, cancelArrow, undo, redo, reload, merge,
  ]);
}
