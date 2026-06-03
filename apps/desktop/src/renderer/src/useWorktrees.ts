/**
 * useWorktrees — the worktree + workspace-zone lifecycle for canvas frames,
 * lifted out of Canvas.tsx. A repo frame (base or workspace zone) owns nested
 * WORKTREE sub-frames; attaching/creating one spawns a child FrameState
 * (parentFrameId = the repo frame). This hook owns the IPC (worktreeCreate/
 * worktreeRemove/pickProjectFolder/resolveProject/installAgentic), the
 * in-flight-create guard, and the destructive-detach confirm. Canvas passes its
 * state refs + setters as context and wires the returned handlers into FrameNode.
 */
import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { frameColorFor } from "./frame-color";
import { remoteBasename } from "../../shared/remote-uri";
import { nextSlotInFrame, FRAME_ROW_MAX, FRAME_GAP } from "./frame-layout";
import { defaultSizeForKind, FRAME_PAD, FRAME_HEADER, FRAME_EMPTY_W, FRAME_EMPTY_H } from "./canvas-sizing";
import type { FrameState, TileInstance } from "./canvas-persistence";
import type { TileStatusKind } from "./agent-status-bus";
import type { WorktreeEntry } from "../../shared/ipc";

type Toast = { tileId: string; label: string; status: TileStatusKind };

export interface WorktreesCtx {
  framesRef: MutableRefObject<FrameState[]>;
  tilesRef: MutableRefObject<TileInstance[]>;
  positionsRef: MutableRefObject<Record<string, { x: number; y: number }>>;
  sizesRef: MutableRefObject<Record<string, { width: number; height: number }>>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  repoPathRef: MutableRefObject<string | null>;
  lastActiveFrameRef: MutableRefObject<string | null>;
  pushToastRef: MutableRefObject<((t: Toast) => void) | null>;
  setFrames: Dispatch<SetStateAction<FrameState[]>>;
  setFrameOf: Dispatch<SetStateAction<Record<string, string>>>;
  setSelectedFrameId: Dispatch<SetStateAction<string | null>>;
  focusTile: (id: string) => void;
  closeTile: (id: string) => void;
}

export function useWorktrees(ctx: WorktreesCtx) {
  const {
    framesRef, tilesRef, positionsRef, sizesRef, frameOfRef, repoPathRef,
    lastActiveFrameRef, pushToastRef, setFrames, setFrameOf, setSelectedFrameId, focusTile, closeTile,
  } = ctx;

  // The repo a frame's worktrees live under: a workspace zone's bound repo,
  // else the canvas base repo.
  const frameRepo = useCallback((frameId: string): string | null => {
    const f = framesRef.current.find((x) => x.id === frameId);
    return f?.workspacePath ?? repoPathRef.current ?? null;
  }, [framesRef, repoPathRef]);

  // Spawn a worktree sub-frame nested in repo frame `parentId`, packed beside
  // existing sibling worktree frames AND the parent's direct tiles (so it never
  // lands on a tile). Re-selecting an already-attached worktree just focuses.
  const spawnWorktreeFrame = useCallback(
    (parentId: string, wt: { branch: string; path: string; head: string }) => {
      const parent = framesRef.current.find((f) => f.id === parentId);
      if (!parent) return;
      // Nesting is exactly 2 levels (repo → worktree). Never nest under a child.
      if (parent.parentFrameId) return;
      const dup = framesRef.current.find(
        (f) => f.parentFrameId === parentId && f.worktreePath === wt.path,
      );
      if (dup) { setSelectedFrameId(dup.id); focusTile(dup.id); return; }
      const siblings = framesRef.current
        .filter((f) => f.parentFrameId === parentId)
        .map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h }));
      for (const t of tilesRef.current) {
        if (frameOfRef.current[t.id] !== parentId) continue;
        const p = positionsRef.current[t.id];
        if (!p) continue;
        const sz = sizesRef.current[t.id] ?? defaultSizeForKind(t.kind);
        siblings.push({ id: t.id, x: p.x, y: p.y, w: sz.width, h: sz.height });
      }
      const slot = nextSlotInFrame(
        { x: parent.x, y: parent.y },
        siblings,
        { w: FRAME_EMPTY_W, h: FRAME_EMPTY_H },
        { padX: FRAME_PAD, padTop: FRAME_HEADER + FRAME_PAD, gap: FRAME_GAP, maxRowWidth: FRAME_ROW_MAX },
      );
      const id = `frame-wt-${Date.now()}`;
      const maxZ = framesRef.current.reduce((m, f) => (f.z > m ? f.z : m), 0);
      const child: FrameState = {
        id, x: slot.x, y: slot.y, w: FRAME_EMPTY_W, h: FRAME_EMPTY_H,
        title: wt.branch, color: frameColorFor(id), z: maxZ + 1,
        branch: wt.branch, worktreePath: wt.path, head: wt.head,
        parentFrameId: parentId,
      };
      lastActiveFrameRef.current = id;
      framesRef.current = [...framesRef.current, child];
      setFrames((fs) => [...fs, child]);
      setSelectedFrameId(id);
      requestAnimationFrame(() => focusTile(id));
    },
    [framesRef, tilesRef, positionsRef, sizesRef, frameOfRef, lastActiveFrameRef, setFrames, setSelectedFrameId, focusTile],
  );

  const onAttachWorktree = useCallback(
    (parentId: string, entry: WorktreeEntry) => {
      if (!entry.branch) {
        pushToastRef.current?.({ tileId: `frame-wt-${parentId}`, label: "can't attach a detached worktree", status: "blocked" });
        return;
      }
      spawnWorktreeFrame(parentId, { branch: entry.branch, path: entry.path, head: entry.head });
    },
    [spawnWorktreeFrame, pushToastRef],
  );

  // Branches with an in-flight `worktreeCreate` — guards against a double-click
  // spawning two frames (the spawnWorktreeFrame dedupe keys on a path that
  // doesn't exist yet).
  const creatingWtRef = useRef<Set<string>>(new Set());
  const onCreateWorktree = useCallback(
    async (parentId: string, rawBranch: string) => {
      const branch = rawBranch.trim();
      const repo = frameRepo(parentId);
      if (!branch || !repo) return;
      const key = `${parentId}::${branch}`;
      if (creatingWtRef.current.has(key)) return;
      creatingWtRef.current.add(key);
      try {
        const res = await window.hive.worktreeCreate(repo, { branch });
        // worktreeCreate returns {path, branch} only — fetch the head sha so the
        // pill is complete (best-effort).
        let head = "";
        try {
          const ws = await window.hive.worktreeList(repo);
          head = ws.find((w) => w.path === res.path)?.head ?? "";
        } catch { /* head stays empty */ }
        spawnWorktreeFrame(parentId, { branch: res.branch, path: res.path, head });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[hivemind] worktree create failed:", msg);
        pushToastRef.current?.({ tileId: `frame-wt-${parentId}`, label: `create ${branch} failed: ${msg.slice(0, 120)}`, status: "blocked" });
      } finally {
        creatingWtRef.current.delete(key);
      }
    },
    [frameRepo, spawnWorktreeFrame, pushToastRef],
  );

  // Detach a worktree sub-frame: remove its worktree on disk (destructive),
  // close its tiles (their cwd is gone), then drop the child frame.
  const unbindBranch = useCallback(async (frameId: string) => {
    const frame = framesRef.current.find((f) => f.id === frameId);
    if (!frame) return;
    const repo = frame.parentFrameId ? frameRepo(frame.parentFrameId) : repoPathRef.current;
    if (frame.worktreePath && repo) {
      const ok = typeof window.confirm === "function"
        ? window.confirm(`Detach worktree "${frame.branch}"?\n\n${frame.worktreePath}\n\nUncommitted changes there will be lost.`)
        : true;
      if (!ok) return;
      try {
        await window.hive.worktreeRemove(repo, frame.worktreePath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[hivemind] worktree remove failed:", msg);
        pushToastRef.current?.({ tileId: `frame-unbind-${frameId}`, label: `detach failed: ${msg.slice(0, 120)}`, status: "blocked" });
        return;
      }
    }
    const memberTiles = Object.keys(frameOfRef.current).filter((tid) => frameOfRef.current[tid] === frameId);
    for (const tid of memberTiles) closeTile(tid);
    if (memberTiles.length) {
      // Drop their membership too — else frameOf accumulates dead keys.
      setFrameOf((m) => {
        const copy = { ...m };
        for (const tid of memberTiles) delete copy[tid];
        return copy;
      });
    }
    setFrames((fs) => fs.filter((f) => f.id !== frameId));
  }, [frameRepo, closeTile, framesRef, repoPathRef, frameOfRef, pushToastRef, setFrameOf, setFrames]);

  // Bind a frame to an arbitrary repo folder so multiple projects coexist on one
  // canvas. Tiles inside then run with cwd/repoPath = that repo + root = its
  // .hivemind. Reuses the folder picker + project resolver; installs the agentic
  // stack so the zone's agents can work issues.
  const bindWorkspace = useCallback(async (frameId: string) => {
    try {
      const dir = await window.hive.pickProjectFolder();
      if (!dir) return;
      const proj = await window.hive.resolveProject(dir);
      const wsPath = proj.repoPath ?? dir;
      const name = wsPath.split("/").filter(Boolean).pop() ?? "workspace";
      setFrames((fs) =>
        fs.map((f) => (f.id === frameId ? { ...f, workspacePath: wsPath, workspaceRoot: proj.root ?? null, title: name } : f)),
      );
      void window.hive.installAgentic(wsPath).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[hivemind] bind workspace failed:", msg);
      pushToastRef.current?.({ tileId: `frame-ws-${frameId}`, label: `bind workspace failed: ${msg.slice(0, 120)}`, status: "blocked" });
    }
  }, [setFrames, pushToastRef]);

  const unbindWorkspace = useCallback((frameId: string) => {
    setFrames((fs) => fs.map((f) => (f.id === frameId ? { ...f, workspacePath: undefined, workspaceRoot: undefined } : f)));
  }, [setFrames]);

  // Bind a REMOTE (ssh://) target as the frame's workspace. The uri flows
  // through mkTile into every tile's cwd/repoPath exactly like a local
  // workspacePath — so the frame's terminals/editor/diff all run on the remote.
  // workspaceRoot stays null (issues remain the local project's — MVP).
  const bindRemote = useCallback((frameId: string, uri: string) => {
    const title = remoteBasename(uri);
    setFrames((fs) =>
      fs.map((f) => (f.id === frameId ? { ...f, workspacePath: uri, workspaceRoot: null, title } : f)),
    );
  }, [setFrames]);

  return { frameRepo, spawnWorktreeFrame, onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace, bindRemote };
}
