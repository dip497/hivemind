/**
 * useSpawn — tile spawning + in-frame placement, lifted from Canvas.tsx. Owns:
 * placeInFrame (slot packing + auto-grow), ensureFrame (resolve/lazily-create
 * the target frame), spawnTile (the single-source create path), and the
 * spawnInto/spawnClaude/spawnVis/frameOpen wrappers. Canvas passes its state
 * refs + setters as context; the handlers read/update them exactly as before.
 */
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { frameColorFor } from "./frame-color";
import { nextSlotInFrame, FRAME_ROW_MAX } from "./frame-layout";
import { defaultSizeForKind, defaultTileSize } from "./canvas-sizing";
import { agentById } from "./agents";
import { defaultShell, type FrameState, type TileInstance } from "./canvas-persistence";
import { queueWork } from "./claude-bus";
import type { TileKind } from "./tile-kinds";

/** Kinds that are one-per-frame (spawn → focus existing). claude/shell are not. */
const SINGLETON_KINDS: ReadonlySet<TileKind> = new Set(["editor", "diff", "issues"]);

type FocusReq = { id: string; cx: number; cy: number; n: number } | null;
type SpawnPick = { kind: TileKind; mode?: string; work?: string } | null;

export interface SpawnCtx {
  repoPath: string | null;
  claudeMode: string;
  positionsRef: MutableRefObject<Record<string, { x: number; y: number }>>;
  sizesRef: MutableRefObject<Record<string, { width: number; height: number }>>;
  tilesRef: MutableRefObject<TileInstance[]>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  framesRef: MutableRefObject<FrameState[]>;
  selectedFrameIdRef: MutableRefObject<string | null>;
  selectedTileIdRef: MutableRefObject<string | null>;
  repoPathRef: MutableRefObject<string | null>;
  rootRef: MutableRefObject<string | null>;
  lastActiveFrameRef: MutableRefObject<string | null>;
  claudeSeqRef: MutableRefObject<number>;
  setFrameOf: Dispatch<SetStateAction<Record<string, string>>>;
  setPositions: Dispatch<SetStateAction<Record<string, { x: number; y: number }>>>;
  setSelectedTileId: Dispatch<SetStateAction<string | null>>;
  setFocusReq: Dispatch<SetStateAction<FocusReq>>;
  setFrames: Dispatch<SetStateAction<FrameState[]>>;
  setSelectedFrameId: Dispatch<SetStateAction<string | null>>;
  setTiles: Dispatch<SetStateAction<TileInstance[]>>;
  setSpawnPick: Dispatch<SetStateAction<SpawnPick>>;
  focusTile: (id: string) => void;
}

export function useSpawn(ctx: SpawnCtx) {
  const {
    repoPath, claudeMode,
    positionsRef, sizesRef, tilesRef, frameOfRef, framesRef, selectedFrameIdRef,
    selectedTileIdRef, repoPathRef, rootRef, lastActiveFrameRef, claudeSeqRef,
    setFrameOf, setPositions, setSelectedTileId, setFocusReq, setFrames,
    setSelectedFrameId, setTiles, setSpawnPick, focusTile,
  } = ctx;

  const placeInFrame = useCallback((id: string, frame: FrameState) => {
    const padX = 24;
    const padTop = 48;
    const gap = 24;
    const pos = positionsRef.current;
    const sizeOf = (tid: string) => {
      if (sizesRef.current[tid]) return sizesRef.current[tid]!;
      const k = tilesRef.current.find((t) => t.id === tid)?.kind;
      return k ? defaultSizeForKind(k) : defaultTileSize(tid);
    };

    // Existing occupants of THIS frame to pack beside: its member tiles (explicit
    // frameOf) PLUS its worktree CHILD frames — so a new tile never lands on top
    // of a nested worktree frame (and vice-versa; spawnWorktreeFrame packs around
    // these same tiles). One occupancy model = the parent divides space properly.
    const members: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    for (const t of tilesRef.current) {
      if (t.id === id) continue;
      if (frameOfRef.current[t.id] !== frame.id) continue;
      const p = pos[t.id];
      if (!p) continue;
      const s = sizeOf(t.id);
      members.push({ id: t.id, x: p.x, y: p.y, w: s.width, h: s.height });
    }
    for (const cf of framesRef.current) {
      if (cf.parentFrameId === frame.id) members.push({ id: cf.id, x: cf.x, y: cf.y, w: cf.w, h: cf.h });
    }
    const me = sizeOf(id);
    const slot = nextSlotInFrame(
      { x: frame.x, y: frame.y },
      members,
      { w: me.width, h: me.height },
      { padX, padTop, gap, maxRowWidth: FRAME_ROW_MAX },
    );
    const placeX = slot.x;
    const placeY = slot.y;
    // This frame is now the user's focus — keep it anchored during separation.
    lastActiveFrameRef.current = frame.id;

    // Record membership EXPLICITLY + set position. The auto-fit effect grows
    // the frame to contain it (membership is no longer geometry-derived, so
    // there's no deadlock if the new tile's center lands outside the frame).
    setFrameOf((m) => ({ ...m, [id]: frame.id }));
    setPositions((p) => ({ ...p, [id]: { x: placeX, y: placeY } }));
    // SINGLE focus+select authority for placed tiles. Every spawn path routes
    // through placeInFrame, so callers must NOT also focus/select (that fired
    // the animation twice). Center on the KNOWN coords directly (don't wait
    // for the positions ref to settle).
    setSelectedTileId(id);
    setFocusReq((prev) => ({ id, cx: placeX + me.width / 2, cy: placeY + me.height / 2, n: (prev?.n ?? 0) + 1 }));
  }, [repoPath]);

  // frame = workspace: EVERY tile lives in a frame, never loose on the canvas.
  // Returns the frame to open into — the active one, else the first existing,
  // else lazily creates a "base" workspace frame bound to the launch repo (so
  // the empty playground gets a real workspace the moment you open anything).
  const ensureFrame = useCallback((): FrameState => {
    const sel = selectedFrameIdRef.current;
    const selF = sel ? framesRef.current.find((f) => f.id === sel) : undefined;
    if (selF) return selF;
    // Prefer a workspace-bound TOP-LEVEL frame over an empty base — without
    // this, a user-bound zone (e.g. "manageark") that wasn't created first
    // would lose spawns to a stale base frame, and tiles would land off-screen
    // relative to the visible workspace. Never auto-route into a worktree
    // sub-frame (parentFrameId set) — those are spawned-into only on explicit
    // selection, else an unselected spawn would land in a random worktree.
    const bound = framesRef.current.find((f) => !f.parentFrameId && f.workspacePath);
    if (bound) return bound;
    const first = framesRef.current.find((f) => !f.parentFrameId);
    if (first) return first;
    const id = `frame-${Date.now()}`;
    const rp = repoPathRef.current;
    // If old tiles already exist on the canvas (persisted from before
    // frame=workspace landed), size the base frame to WRAP them so they
    // visually live inside the workspace (instead of looking loose + new
    // spawns landing on the wrong empty slot).
    let x = 80, y = 80, w = 1860, h = 1380;
    const pos = positionsRef.current;
    const sz = sizesRef.current;
    const tileEntries = Object.entries(pos);
    if (tileEntries.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [tid, p] of tileEntries) {
        const s = sz[tid] ?? { width: 700, height: 480 };
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x + s.width > maxX) maxX = p.x + s.width;
        if (p.y + s.height > maxY) maxY = p.y + s.height;
      }
      x = Math.max(0, minX - 24);
      y = Math.max(0, minY - 48);
      w = Math.max(1860, maxX - x + 24);
      h = Math.max(1380, maxY - y + 24);
    }
    const frame: FrameState = {
      id,
      x, y,
      w: Math.max(w, 2520),
      h: Math.max(h, 1780),
      title: rp?.split("/").filter(Boolean).pop() ?? "workspace",
      color: frameColorFor(id), z: 0,
      workspacePath: rp ?? undefined, workspaceRoot: rootRef.current ?? null,
    };
    setFrames((fs) => (fs.length ? fs : [frame]));
    setSelectedFrameId(id);
    // Adopt any pre-existing loose tiles into this base frame (explicit
    // membership) so they're treated as members by auto-fit + parenting.
    if (tileEntries.length > 0) {
      setFrameOf((m) => {
        const copy = { ...m };
        for (const [tid] of tileEntries) if (!copy[tid]) copy[tid] = id;
        return copy;
      });
    }
    // Sync the ref NOW so an immediately-following placeInFrame / doSpawnClaude
    // (both read framesRef) see the new frame before the next render commits.
    if (!framesRef.current.length) framesRef.current = [frame];
    return frame;
  }, []);

  // Wrap legacy loose tiles on mount: layouts persisted before frame=workspace
  // landed have positions but no frames → create the base frame sized to their
  // bounding box so they visually live INSIDE the workspace (and the slot
  // scanner sees them as occupied, so new spawns land in free slots).
  const wrapOnceRef = useRef(false);
  useEffect(() => {
    if (wrapOnceRef.current) return;
    if (!repoPath) return;
    if (framesRef.current.length > 0) { wrapOnceRef.current = true; return; }
    if (Object.keys(positionsRef.current).length === 0) return;
    wrapOnceRef.current = true;
    ensureFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  // Create a tile of `kind` inside `targetFrameId` (or the resolved active
  // frame). claude/shell are unlimited per frame; editor/diff/issues are
  // one-per-frame — if the frame already has one, focus it instead of making a
  // duplicate. placeInFrame lays it out + auto-grows the frame + selects/foci.
  const spawnTile = useCallback(
    (kind: TileKind, targetFrameId: string | null, opts?: { mode?: string; work?: string; agent?: { id: string; cmd: string; args?: string[]; label: string } }): void => {
      const frame = (targetFrameId ? framesRef.current.find((f) => f.id === targetFrameId) : undefined) ?? ensureFrame();
      const fid = frame.id;
      if (SINGLETON_KINDS.has(kind)) {
        const existing = tilesRef.current.find((t) => t.kind === kind && frameOfRef.current[t.id] === fid);
        if (existing) { setSelectedTileId(existing.id); focusTile(existing.id); return; }
      }
      const n = ++claudeSeqRef.current;
      const newId = `tile-${kind}-${Date.now()}`;
      let cmd: string | undefined;
      let args: string[] | undefined;
      let label: string;
      if (kind === "claude" && opts?.agent) {
        // A non-claude agent (codex / opencode / …) runs in the same agent-
        // terminal kind; its binary + default flags come from the registry, and
        // status detection keys off the cmd (identifyAgent), not the kind.
        cmd = opts.agent.cmd;
        args = opts.agent.args ?? [];
        label = `${opts.agent.label} #${n}`;
      } else if (kind === "claude") {
        const m = opts?.mode || claudeMode;
        // bypassPermissions is gated behind its own flag — `--permission-mode
        // bypassPermissions` is refused at startup; the canonical entry is
        // `--dangerously-skip-permissions` (cli-reference).
        args = m === "bypassPermissions"
          ? ["--dangerously-skip-permissions"]
          : m && m !== "default" ? ["--permission-mode", m] : [];
        cmd = "claude";
        label = `claude #${n}${m && m !== "default" ? ` · ${m}` : ""}`;
      } else if (kind === "shell") {
        const sh = defaultShell();
        cmd = sh.cmd; args = sh.args;
        label = `shell #${n}`;
      } else {
        label = kind === "editor" ? "Editor" : kind === "diff" ? "Diff" : "Issues";
      }
      placeInFrame(newId, frame);
      setTiles((cur) => [...cur, { id: newId, kind, label, cmd, args }]);
      // "Work on this": hand the fresh claude tile its prompt. It delivers it to
      // itself the first time it's ready (see claude-bus queueWork/claimWork).
      if (kind === "claude" && opts?.work) queueWork(newId, opts.work);
    },
    [claudeMode, placeInFrame, ensureFrame, focusTile],
  );

  // Spawn from a global surface (ToolIsland / palette / hotkey). A current
  // selection IS the target: a selected frame — or the frame holding the
  // selected tile — spawns straight in, no picker. Only ask when nothing is
  // selected to disambiguate AND 2+ frames exist.
  const spawnInto = useCallback((kind: TileKind, opts?: { mode?: string; work?: string }) => {
    const selTile = selectedTileIdRef.current;
    const selFrame =
      selectedFrameIdRef.current ?? (selTile ? frameOfRef.current[selTile] ?? null : null);
    if (selFrame && framesRef.current.some((f) => f.id === selFrame)) {
      spawnTile(kind, selFrame, opts);
      return;
    }
    if (framesRef.current.length >= 2) {
      setSpawnPick({ kind, mode: opts?.mode, work: opts?.work });
      return;
    }
    spawnTile(kind, ensureFrame().id, opts);
  }, [spawnTile, ensureFrame]);

  // Back-compat thin wrappers for the many existing call sites.
  const spawnClaude = useCallback(
    (mode?: string, work?: string) => spawnInto("claude", { mode, work }),
    [spawnInto],
  );
  const spawnVis = useCallback(
    (which: "tree" | "shell" | "diff" | "issues") => spawnInto(which === "tree" ? "editor" : which),
    [spawnInto],
  );

  // Open a tile INSIDE a specific frame (the frame's launcher toolbar) — always
  // targets that frame, no picker. Same one-per-frame rule via spawnTile.
  const frameOpen = useCallback((frameId: string, kind: string) => {
    // A registry agent (codex / opencode / …) opens as an agent-terminal tile
    // carrying its binary + default flags.
    const agent = agentById(kind);
    if (agent && agent.id !== "claude") {
      spawnTile("claude", frameId, { agent: { id: agent.id, cmd: agent.cmd, args: agent.defaultArgs, label: agent.label } });
      return;
    }
    const k: TileKind =
      kind === "tree" ? "editor"
      : kind === "claude" || kind === "shell" || kind === "diff" || kind === "issues" ? kind
      : "shell";
    spawnTile(k, frameId);
  }, [spawnTile]);

  return { placeInFrame, ensureFrame, spawnTile, spawnInto, spawnClaude, spawnVis, frameOpen };
}
