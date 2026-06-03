/**
 * useFrameOps — frame CRUD (add/title/color/delete/bring-to-front/move), the
 * opt-in arrange (Columns/Rows/Grid), and the reactive auto-fit effect that
 * derives every frame's geometry from its member tiles + nested child frames.
 * Lifted from Canvas.tsx; takes Canvas's state refs + setters + the state
 * values the auto-fit effect depends on.
 */
import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { frameColorFor } from "./frame-color";
import { computeFrameLayout, arrangeBoxes, FRAME_ROW_MAX, FRAME_GAP, type ArrangeMode, type ArrangeBox } from "./frame-layout";
import { defaultSizeForKind, defaultTileSize, FRAME_PAD, FRAME_HEADER, FRAME_EMPTY_W, FRAME_EMPTY_H } from "./canvas-sizing";
import type { FrameState, TileInstance } from "./canvas-persistence";
import type { TileKind } from "./tile-kinds";

export interface FrameOpsCtx {
  repoPath: string | null;
  // state values (auto-fit effect deps)
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { width: number; height: number }>;
  tiles: TileInstance[];
  frameOf: Record<string, string>;
  // refs
  framesRef: MutableRefObject<FrameState[]>;
  tilesRef: MutableRefObject<TileInstance[]>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  positionsRef: MutableRefObject<Record<string, { x: number; y: number }>>;
  sizesRef: MutableRefObject<Record<string, { width: number; height: number }>>;
  lastActiveFrameRef: MutableRefObject<string | null>;
  // setters + actions
  setFrames: Dispatch<SetStateAction<FrameState[]>>;
  setPositions: Dispatch<SetStateAction<Record<string, { x: number; y: number }>>>;
  focusTile: (id: string) => void;
}

export function useFrameOps(ctx: FrameOpsCtx) {
  const {
    repoPath, positions, sizes, tiles, frameOf,
    framesRef, tilesRef, frameOfRef, positionsRef, sizesRef, lastActiveFrameRef,
    setFrames, setPositions, focusTile,
  } = ctx;

  const addFrame = useCallback(() => {
    const id = `frame-${Date.now()}`;
    setFrames((fs) => {
      const n = fs.length + 1;
      const maxZ = fs.reduce((m, f) => (f.z > m ? f.z : m), 0);
      // Big enough to hold a tile (workbench/diff are 720-760px wide).
      const w = 840;
      const h = 580;
      // Place each new frame to the RIGHT of all existing frames; auto-pan
      // below then flies the viewport to it, so it's always visible.
      const rightEdge = fs.reduce((m, f) => Math.max(m, f.x + f.w), 0);
      const x = fs.length ? rightEdge + 48 : 120;
      const y = 120;
      return [...fs, { id, x, y, w, h, title: `Group ${n}`, color: frameColorFor(id), z: maxZ + 1 }];
    });
    // Pan to the new frame — rAF lets the node mount before we center on it.
    requestAnimationFrame(() => focusTile(id));
  }, [focusTile, setFrames]);

  const updateFrameTitle = useCallback((id: string, title: string) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, title } : f)));
  }, [setFrames]);
  const updateFrameColor = useCallback((id: string, color: string) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, color } : f)));
  }, [setFrames]);
  const deleteFrame = useCallback((id: string) => {
    // Removing a repo frame also removes its worktree SUB-frames from the
    // canvas — otherwise a child's parentFrameId dangles and computeFrameLayout
    // silently promotes it to a top-level frame. The worktrees stay on DISK
    // (re-attachable via the picker); the destructive removal is the explicit
    // detach (×) on a worktree frame, not a canvas delete.
    setFrames((fs) => fs.filter((f) => f.id !== id && f.parentFrameId !== id));
  }, [setFrames]);

  // Opt-in "tidy": snap a frame's contents — its member tiles AND its worktree
  // sub-frames — into Columns / Rows / Grid. A child frame moves with its member
  // tiles (its geometry derives from them, like a drag).
  const arrangeFrame = useCallback((frameId: string, mode: ArrangeMode) => {
    const frame = framesRef.current.find((f) => f.id === frameId);
    if (!frame) return;
    const boxes: ArrangeBox[] = [];
    const directTiles: string[] = [];
    for (const t of tilesRef.current) {
      if (frameOfRef.current[t.id] !== frameId) continue;
      const p = positionsRef.current[t.id];
      if (!p) continue;
      const s = sizesRef.current[t.id] ?? defaultSizeForKind(t.kind);
      boxes.push({ id: t.id, x: p.x, y: p.y, w: s.width, h: s.height });
      directTiles.push(t.id);
    }
    const childFrames = framesRef.current.filter((f) => f.parentFrameId === frameId);
    for (const cf of childFrames) boxes.push({ id: cf.id, x: cf.x, y: cf.y, w: cf.w, h: cf.h });
    if (boxes.length === 0) return;
    const placed = arrangeBoxes(boxes, mode, {
      originX: frame.x, originY: frame.y,
      padX: FRAME_PAD, padTop: FRAME_HEADER + FRAME_PAD, gap: FRAME_GAP, maxRowWidth: FRAME_ROW_MAX,
    });
    lastActiveFrameRef.current = frameId;
    const tileUpdates: Record<string, { x: number; y: number }> = {};
    const frameUpdates: Record<string, { x: number; y: number }> = {};
    for (const cf of childFrames) {
      const np = placed.get(cf.id);
      if (!np) continue;
      const dx = np.x - cf.x, dy = np.y - cf.y;
      frameUpdates[cf.id] = np;
      for (const t of tilesRef.current) {
        if (frameOfRef.current[t.id] !== cf.id) continue;
        const p = positionsRef.current[t.id];
        if (p) tileUpdates[t.id] = { x: p.x + dx, y: p.y + dy };
      }
    }
    for (const tid of directTiles) {
      const np = placed.get(tid);
      if (np) tileUpdates[tid] = np;
    }
    if (Object.keys(tileUpdates).length) setPositions((prev) => ({ ...prev, ...tileUpdates }));
    if (Object.keys(frameUpdates).length) {
      setFrames((fs) => fs.map((f) => (frameUpdates[f.id] ? { ...f, ...frameUpdates[f.id] } : f)));
    }
  }, [framesRef, tilesRef, frameOfRef, positionsRef, sizesRef, lastActiveFrameRef, setPositions, setFrames]);

  // ── reactive frame auto-fit ───────────────────────────────────────────────
  // Frame geometry is DERIVED from its member tiles, not stored-and-grown.
  // Recompute on tile position/size/visibility/frameOf change (human-action
  // frequency, not per-frame). Membership is EXPLICIT (frameOf), not geometry.
  // `frames` is NOT a dep (updater reads `prev`) → never self-fires.
  useEffect(() => {
    const present = new Set<string>();
    const kindOf = new Map<string, TileKind>();
    for (const t of tiles) {
      if ((t.kind === "editor" || t.kind === "diff") && !repoPath) continue;
      present.add(t.id);
      kindOf.set(t.id, t.kind);
    }

    // Member tile rects + ids per frame (absolute coords).
    const memberRects = new Map<string, Array<{ x: number; y: number; r: number; b: number }>>();
    const memberIds = new Map<string, string[]>();
    for (const tid of present) {
      const fid = frameOf[tid];
      if (!fid) continue;
      const p = positions[tid];
      if (!p) continue;
      const k = kindOf.get(tid);
      const s = sizes[tid] ?? (k ? defaultSizeForKind(k) : defaultTileSize(tid));
      const arr = memberRects.get(fid) ?? [];
      arr.push({ x: p.x, y: p.y, r: p.x + s.width, b: p.y + s.height });
      memberRects.set(fid, arr);
      const ids = memberIds.get(fid) ?? [];
      ids.push(tid);
      memberIds.set(fid, ids);
    }

    // Geometry is PURE: feed member rects to computeFrameLayout (nesting-aware).
    const { geometry, tileShift } = computeFrameLayout(
      framesRef.current,
      memberRects,
      lastActiveFrameRef.current,
      { pad: FRAME_PAD, header: FRAME_HEADER, emptyW: FRAME_EMPTY_W, emptyH: FRAME_EMPTY_H },
    );

    // Commit frame geometry (2px dead-band → no churn / no self-fire loop).
    setFrames((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const fin = geometry.get(f.id);
        if (!fin) return f;
        if (
          Math.abs(fin.x - f.x) < 2 && Math.abs(fin.y - f.y) < 2 &&
          Math.abs(fin.w - f.w) < 2 && Math.abs(fin.h - f.h) < 2
        ) return f;
        changed = true;
        return { ...f, ...fin };
      });
      return changed ? next : prev;
    });

    // Apply each frame's separation delta to ITS member tiles (absolute) so the
    // next derive re-lands the frame at the separated spot. Child-frame shifts
    // already fold in the parent's delta (see computeFrameLayout).
    const tileShifts: Record<string, { dx: number; dy: number }> = {};
    for (const [fid, d] of tileShift) {
      if (d.dx === 0 && d.dy === 0) continue;
      for (const tid of memberIds.get(fid) ?? []) tileShifts[tid] = d;
    }
    const shiftIds = Object.keys(tileShifts);
    if (shiftIds.length) {
      setPositions((p) => {
        let changed = false;
        const np = { ...p };
        for (const id of shiftIds) {
          const c = p[id];
          const s = tileShifts[id]!;
          // Match the frame-geometry dead-band (2px) so a sub-2px residue
          // doesn't shift positions and re-fire the effect.
          if (!c || (Math.abs(s.dx) < 2 && Math.abs(s.dy) < 2)) continue;
          np[id] = { x: c.x + s.dx, y: c.y + s.dy };
          changed = true;
        }
        return changed ? np : p;
      });
    }
  }, [positions, sizes, tiles, repoPath, frameOf, framesRef, lastActiveFrameRef, setFrames, setPositions]);

  // Drag synced on stop (not per-tick); persist the final x/y to source-of-truth.
  const moveFrame = useCallback((id: string, x: number, y: number) => {
    // The dragged frame is the anchor — neighbours yield to where you drop it.
    lastActiveFrameRef.current = id;
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, x, y } : f)));
  }, [lastActiveFrameRef, setFrames]);

  // Bring a frame above all others (bump z to max+1).
  const bringFrameToFront = useCallback((id: string) => {
    setFrames((fs) => {
      const maxZ = fs.reduce((m, f) => (f.z > m ? f.z : m), 0);
      const target = fs.find((f) => f.id === id);
      if (!target || target.z === maxZ) return fs;
      return fs.map((f) => (f.id === id ? { ...f, z: maxZ + 1 } : f));
    });
  }, [setFrames]);

  return { addFrame, updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, moveFrame, bringFrameToFront };
}
