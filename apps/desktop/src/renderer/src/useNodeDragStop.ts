/**
 * useNodeDragStop — the react-flow onNodeDragStop handler, lifted from Canvas.
 * Persists a dropped node's final ABSOLUTE position (converting react-flow's
 * parent-relative coords), carries a dragged frame's body (member tiles, board
 * boxes + worktree child frames), detaches a worktree child dragged out of its
 * parent, and re-derives a tile's or box's frame membership from its drop location.
 */
import { framesWithin } from "@hivemind/workspace-doc/pages";
import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import { defaultSizeForKind, defaultTileSize } from "./canvas-sizing";
import type { FrameState, TileInstance } from "./canvas-persistence";
import { isBoxType } from "./board-objects/board-model";

export interface NodeDragStopCtx {
  framesRef: MutableRefObject<FrameState[]>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  sizesRef: MutableRefObject<Record<string, { width: number; height: number }>>;
  tilesRef: MutableRefObject<TileInstance[]>;
  lastActiveFrameRef: MutableRefObject<string | null>;
  setPositions: Dispatch<SetStateAction<Record<string, { x: number; y: number }>>>;
  setFrames: Dispatch<SetStateAction<FrameState[]>>;
  setFrameOf: Dispatch<SetStateAction<Record<string, string>>>;
  parentFrameOf: (cx: number, cy: number) => { parentId: string; fx: number; fy: number } | null;
  moveFrame: (id: string, x: number, y: number) => void;
  commitPosition: (id: string, x: number, y: number) => void;
  clearDragging: () => void;
  /** Board boxes dropped on the canvas, each at its place (the board decides their frames). */
  moveBoxes: (places: ReadonlyMap<string, { x: number; y: number }>) => void;
  /** Move the boxes in these frames with them. */
  shiftBoxes: (shifts: ReadonlyMap<string, { dx: number; dy: number }>) => void;
}

/** Everything one drag let go of: `moved` is every node the drag carried, `node` the one held. Each
 *  is saved by its type. */
export function dropNodes(ctx: NodeDragStopCtx, node: Node, moved?: readonly Node[]): void {
  ctx.clearDragging();
  const boxes = new Map<string, { x: number; y: number }>();
  for (const n of moved?.some((m) => m.id === node.id) ? moved : [node, ...(moved ?? [])]) dropOne(ctx, n, boxes);
  if (boxes.size) ctx.moveBoxes(boxes);
}

function dropOne(ctx: NodeDragStopCtx, node: Node, boxes: Map<string, { x: number; y: number }>): void {
  const {
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, shiftBoxes,
  } = ctx;
  // Persist final position. Frames update their own list. Tiles: react-flow
  // returns position RELATIVE to parentId when parented, but our positions map
  // stores ABSOLUTE so parentFrameOf can detect frame containment on re-render.
  if (node.type === "frame") {
    // Dragging a frame carries its body. Frame geometry is DERIVED from member
    // tiles (+ child frames), so the move persists by translating those —
    // react-flow's live drag is visual only and our positions map is stale.
    const old = framesRef.current.find((f) => f.id === node.id);
    if (!old) { moveFrame(node.id, node.position.x, node.position.y); return; }
    // A child (worktree) frame returns position RELATIVE to its parent.
    const dragParent = node.parentId ? framesRef.current.find((f) => f.id === node.parentId) : undefined;
    let nx = node.position.x;
    let ny = node.position.y;
    if (dragParent) { nx = dragParent.x + node.position.x; ny = dragParent.y + node.position.y; }
    const dx = nx - old.x;
    const dy = ny - old.y;
    // Detach a worktree child dragged so its CENTER left the parent — it becomes
    // a top-level frame (keeps its worktree). Otherwise auto-fit re-nests it and
    // the drag looks ignored. Re-attach is via the picker.
    const detach = !!dragParent && (() => {
      const ccx = nx + old.w / 2, ccy = ny + old.h / 2;
      return ccx < dragParent.x || ccx > dragParent.x + dragParent.w
        || ccy < dragParent.y || ccy > dragParent.y + dragParent.h;
    })();
    if (dx !== 0 || dy !== 0 || detach) {
      // Everything that moves with this frame: its descendant child frames, plus
      // every member tile of the frame AND its descendants. Shifting member tiles
      // re-lands non-empty frames; shifting frame x/y re-lands empty ones.
      const movedFrames = framesWithin(framesRef.current, node.id);
      const moveIds = Object.keys(frameOfRef.current).filter((tid) =>
        movedFrames.has(frameOfRef.current[tid]!),
      );
      if (moveIds.length > 0) {
        setPositions((prev) => {
          const next = { ...prev };
          for (const tid of moveIds) {
            const p = next[tid];
            if (p) next[tid] = { x: p.x + dx, y: p.y + dy };
          }
          return next;
        });
      }
      shiftBoxes(new Map([...movedFrames].map((id) => [id, { dx, dy }])));
      lastActiveFrameRef.current = node.id;
      setFrames((fs) =>
        fs.map((f) => {
          if (f.id === node.id) {
            return detach ? { ...f, x: nx, y: ny, parentFrameId: undefined } : { ...f, x: nx, y: ny };
          }
          if (movedFrames.has(f.id)) return { ...f, x: f.x + dx, y: f.y + dy };
          return f;
        }),
      );
      return;
    }
    moveFrame(node.id, nx, ny);
    return;
  }
  // xyflow v12.3.6 returns `positionAbsolute: undefined` for parented nodes —
  // only `node.position` (RELATIVE to parent) is populated. Compute absolute.
  const absRaw = (node as { positionAbsolute?: { x: number; y: number } }).positionAbsolute;
  let ax = node.position.x;
  let ay = node.position.y;
  if (absRaw) {
    ax = absRaw.x;
    ay = absRaw.y;
  } else if (node.parentId) {
    const parent = framesRef.current.find((f) => f.id === node.parentId);
    if (parent) {
      ax = parent.x + node.position.x;
      ay = parent.y + node.position.y;
    }
  }
  if (isBoxType(node.type)) {
    boxes.set(node.id, { x: ax, y: ay });
    return;
  }
  commitPosition(node.id, ax, ay);
  // Update EXPLICIT membership from the drop location: the tile joins whichever
  // frame contains its CENTER (topmost), or becomes loose if dropped outside.
  // The ONLY place geometry maps to membership — a one-shot user action.
  const dragKind = tilesRef.current.find((t) => t.id === node.id)?.kind;
  const s = sizesRef.current[node.id] ?? (dragKind ? defaultSizeForKind(dragKind) : defaultTileSize(node.id));
  const hit = parentFrameOf(ax + s.width / 2, ay + s.height / 2);
  setFrameOf((m) => {
    const cur = m[node.id];
    const nextId = hit?.parentId;
    if (cur === nextId) return m;
    const copy = { ...m };
    if (nextId) copy[node.id] = nextId;
    else delete copy[node.id];
    return copy;
  });
}

export function useNodeDragStop(ctx: NodeDragStopCtx) {
  const ref = useRef(ctx);
  ref.current = ctx;
  return useCallback((_e: unknown, node: Node, moved?: readonly Node[]) => dropNodes(ref.current, node, moved), []);
}
