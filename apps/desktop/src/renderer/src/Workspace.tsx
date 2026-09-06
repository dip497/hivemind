/**
 * Workspace — the workspace RUNTIME and composition root (formerly Canvas.tsx).
 *
 * Owns what every view shares: frames + their repo bindings (worktree /
 * workspace / remote), tile identity + open set + membership, selection, names,
 * editor tabs, the HCP control-plane wiring, agent awareness, commands (spawn /
 * close / focus / …) and persistence of the core blob. It renders:
 *
 *   • the ACTIVE VIEW plugin (workspace/views — canvas, windows, …) behind a
 *     crash boundary with fallback (workspace/view-host.tsx); a view receives a
 *     read-only model + commands, never react-flow nodes;
 *   • the TileHost (workspace/tile-host.tsx) — every open tile's live body,
 *     mounted ONCE for the life of the tile and lent to whichever view shows it,
 *     so switching views never remounts a terminal / editor / browser (a remote
 *     PTY has no daemon; its unmount would kill the agent);
 *   • the cross-view overlays (spawn/claude pickers, remote-connect and git
 *     modals).
 *
 * Milestone-1 seam: the canvas view's geometry (tile positions/sizes/viewport)
 * still lives here and reaches CanvasView through CanvasRuntimeContext, because
 * the hooks that mutate it (useSpawn placement, useFrameOps auto-fit,
 * useWorktrees, useNodeDragStop) also do core work and must run while another
 * view is active. See workspace/views/canvas-runtime.ts + the design doc.
 *
 * The work lives in extracted modules/hooks that destructure a `ctx` object —
 * keep it that way (this file was decomposed out of a 3147-LOC god component).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { LayerTile, LayerFrame } from "./LayersPanel";
import { statusOf, setWaitStatus, setSubagentBusy, setNotify, setTurnState, type TileStatusKind } from "./agent-status-bus";
import { frameAtPoint } from "./frame-layout";
import { Wallpaper } from "./Wallpaper";
import { CanvasOverlay } from "./CanvasOverlay";
import { applyTheme } from "./theme-store";
import type { PinRect } from "./workspace/tile-surfaces";
import { clampAnchor } from "./pin-anchor";
import type { TileKind } from "./tile-kinds";
import {
  loadLayout,
  saveLayout,
  type TileInstance,
  type FrameState,
} from "./canvas-persistence";
import { useStateWithRef } from "./use-state-with-ref";
import { defaultTileSize } from "./canvas-sizing";
import { useWorktrees } from "./useWorktrees";
import { RemoteConnectModal } from "./components/RemoteConnectModal";
import { isRemote } from "../../shared/remote-uri";
import { AGENTS, AgentIcon, agentById, agentForCmd } from "./agents";
import { useSpawn } from "./useSpawn";
import { useFrameOps } from "./useFrameOps";
import { useAgentAwareness } from "./useAgentAwareness";
import { unmarkBackgroundTile } from "./worker-tiles";
import { useCanvasShortcuts } from "./useCanvasShortcuts";
import { useNodeDragStop } from "./useNodeDragStop";
import { GitCommitModal } from "./GitCommitModal";
import { useGitPush, useGitPull } from "./queries";
import { buildTileSurfaces } from "./workspace/tile-surfaces";
import { TileHost } from "./workspace/tile-host";
import { ViewHost } from "./workspace/view-host";
import {
  FALLBACK_VIEW_ID, getView, resolveViewId,
  type SpawnOpts, type WorkspaceCommands, type WorkspaceViewModel,
} from "./workspace/workspace-view";
import { saveViewLayout, useDebouncedSave } from "./workspace/view-layout-store";
import { setViewMode, useViewMode } from "./workspace/view-mode-store";
import { CANVAS_LAYOUT, loadCanvasLayout } from "./workspace/views/canvas-layout";
import { CanvasRuntimeContext, type CanvasRuntime, type FocusModeReq, type FocusReq, type Viewport } from "./workspace/views/canvas-runtime";
// Registers the built-in view plugins (side effect) before the first render.
import "./workspace/views";

// Snap on drop to an 8px grid (Figma's standard). The drop xyflow hands us is
// raw cursor; rounding to 8px means the tile travels a few px from cursor to
// grid — and because `.canvas-dragging` is removed SYNC on dragstop, the
// `.react-flow__node` 280ms transition (Linear-app ease-out-quint) animates
// that travel. THAT is the "smooth land" moment. Below ~4px the travel is too
// small to read as motion.
const SNAP_GRID: [number, number] = [8, 8];
const DEFAULT_VIEWPORT: Viewport = { x: 16, y: 24, zoom: 1 };

interface Props {
  cwd: string;
  repoPath: string | null;
  /** Workspace root (.hivemind parent) — issues are keyed by this, not repoPath. */
  root?: string | null;
  /** When the launched folder has no .hivemind/, App provides this so the
   *  CanvasEmptyState can offer "Initialize workspace here…" (the old top-left
   *  switcher's job). Undefined when a workspace is already resolved. */
  onInitWorkspace?: () => void;
  /** A newer GitHub release exists → show the "Update available" pill by Theme.
   *  Owned by App (so the Settings dialog + this pill share one check). */
  updateAvailable?: boolean;
  /** Run the installer + restart (from the pill). */
  onUpgrade?: () => void;
  /** An upgrade is in flight — the pill shows a spinner + is click-inert. */
  upgrading?: boolean;
}

export function Workspace({ cwd, repoPath, root = null, onInitWorkspace, updateAvailable = false, onUpgrade, upgrading = false }: Props) {
  // Persistence key for the workspace. Prefer repoPath (a git/.hivemind
  // project); fall back to the absolute cwd so a plain folder — including
  // `$HOME` — still persists + resumes. Keyed on the absolute path (never a
  // shared `__global__` sentinel), so distinct folders never leak into each
  // other. An empty cwd (welcome/e2e bootstrap) stays transient (null) and is
  // intentionally NOT persisted.
  const persistKey = repoPath ?? (cwd || null);
  // Bootstrapped from localStorage on first render (synchronous useState
  // initializer so we never flash an empty canvas before hydrating). Reloaded
  // when the persistence key changes — see the effect below. The canvas view's
  // geometry is its own versioned blob (imported from the pre-v2 core blob once).
  const initial = useMemo(() => loadLayout(persistKey), [persistKey]);
  const canvasInitial = useMemo(() => loadCanvasLayout(persistKey), [persistKey]);

  // All open tiles, every kind, as instances. Mirror to a ref so callbacks
  // declared before later state can read the latest list without re-creating.
  const [tiles, setTiles, tilesRef] = useStateWithRef<TileInstance[]>(initial.tiles ?? []);
  // Live agent pipes (HCP hive_connect) → animated data-flow edges. Ephemeral.
  const [pipes, setPipes] = useState<{ src: string; dst: string }[]>([]);
  // Spawn-parentage wires (parent → child) — a spawned sub-agent / workflow worker
  // shows a persistent dashed line to the agent that spawned it. Ephemeral.
  const [spawnLinks, setSpawnLinks] = useState<{ parent: string; child: string }[]>([]);
  // Files opened in each editor tile — tabs keyed by editor tile id.
  const [editorTabs, setEditorTabs] = useState<Record<string, string[]>>(initial.editorTabs ?? {});

  // ── canvas geometry (hosted here for the canvas view — see canvas-runtime.ts) ──
  // Runtime per-tile dimension overrides. Once the user drags a NodeResizer
  // corner we capture the committed size here; without it the memo-rebuilt node
  // spec re-applies the old style.width/height and the resize visually no-ops.
  const [sizes, setSizes, sizesRef] = useStateWithRef<Record<string, { width: number; height: number }>>(canvasInitial.sizes);
  // User-renamed tile labels (per tile id). Persisted with layout. Holds USER
  // renames ONLY — an absent entry means "use the auto/agent name".
  const [tileNames, setTileNames] = useState<Record<string, string>>(initial.tileNames ?? {});
  const renameTile = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    setTileNames((m) => {
      if (!trimmed) {
        if (!(id in m)) return m;
        const { [id]: _, ...rest } = m;
        return rest;
      }
      if (m[id] === trimmed) return m;
      return { ...m, [id]: trimmed };
    });
  }, []);
  // Live agent session titles from the terminal OSC window-title. NOT persisted
  // here — the DAEMON owns the title as session state and re-emits it ahead of
  // the replay on every attach. A user rename (tileNames) takes precedence.
  const [agentTitles, setAgentTitles] = useState<Record<string, string>>({});
  const setAgentTitle = useCallback((id: string, title: string) => {
    setAgentTitles((m) => (m[id] === title ? m : { ...m, [id]: title }));
  }, []);
  const onNodeResizeCommit = useCallback((id: string, width: number, height: number, x?: number, y?: number) => {
    setSizes((s) => {
      const cur = s[id];
      if (cur && cur.width === width && cur.height === height) return s;
      return { ...s, [id]: { width, height } };
    });
    if (x != null && y != null) {
      // NodeResizer reports x/y RELATIVE to the parent frame for a child node,
      // but our positions map is ABSOLUTE world coords. Add the frame origin
      // back when the tile lives in one, else the tile jumps on next render.
      const fid = frameOfRef.current[id];
      const fr = fid ? framesRef.current.find((f) => f.id === fid) : undefined;
      const ax = fr ? fr.x + x : x;
      const ay = fr ? fr.y + y : y;
      setPositions((p) => {
        const cur = p[id];
        if (cur && cur.x === ax && cur.y === ay) return p;
        return { ...p, [id]: { x: ax, y: ay } };
      });
    }
    // Frame resize is handled reactively by the auto-fit effect.
  }, []);

  // Proportional tile scale from a terminal header's hover slider: grow the NODE
  // box by the same ratio as the font so the whole terminal scales in proportion.
  useEffect(() => {
    const onScale = (e: Event) => {
      const d = (e as CustomEvent<{ tileId: string; ratio: number }>).detail;
      if (!d?.tileId || !Number.isFinite(d.ratio) || d.ratio <= 0) return;
      const cur = sizesRef.current[d.tileId] ?? defaultTileSize(d.tileId);
      const width = Math.max(340, Math.min(4200, Math.round(cur.width * d.ratio)));
      const height = Math.max(200, Math.min(2800, Math.round(cur.height * d.ratio)));
      onNodeResizeCommit(d.tileId, width, height);
    };
    window.addEventListener("hivemind:scale-tile", onScale as EventListener);
    return () => window.removeEventListener("hivemind:scale-tile", onScale as EventListener);
  }, [onNodeResizeCommit]);

  // Tile positions (absolute world coords). Populated by drag-stop + placement.
  const [positions, setPositions, positionsRef] = useStateWithRef<Record<string, { x: number; y: number }>>(canvasInitial.positions);
  const commitPosition = useCallback((id: string, x: number, y: number) => {
    // Snap on COMMIT (not during drag) — snapping during motion teleports the
    // tile in grid steps every pointermove → feels notchy. Snap only on release.
    const g = SNAP_GRID[0];
    const sx = Math.round(x / g) * g;
    const sy = Math.round(y / g) * g;
    setPositions((p) => {
      const cur = p[id];
      if (cur && cur.x === sx && cur.y === sy) return p;
      return { ...p, [id]: { x: sx, y: sy } };
    });
  }, []);

  // Tile selection — the one tile that takes keyboard input, in every view.
  const [selectedTileId, setSelectedTileId, selectedTileIdRef] = useStateWithRef<string | null>(null);
  // Focus mode: fitView to one node (`.`) / fit all (Esc). Same nonce pattern
  // as focusReq so re-firing the same id still triggers.
  const [focusModeReq, setFocusModeReq] = useState<FocusModeReq>(null);
  const focusModeNonceRef = useRef(0);

  // Open a file as a tab in a SPECIFIC editor tile. The EditorTile picks the
  // newly-appended tab as active.
  const openFileInTile = useCallback((tileId: string, file: string) => {
    setEditorTabs((m) => {
      const cur = m[tileId] ?? [];
      if (cur.includes(file)) return m;
      return { ...m, [tileId]: [...cur, file] };
    });
    setSelectedTileId(tileId);
  }, []);
  const closeTabInTile = useCallback((tileId: string, file: string) => {
    setEditorTabs((m) => {
      const cur = m[tileId];
      if (!cur) return m;
      return { ...m, [tileId]: cur.filter((f) => f !== file) };
    });
  }, []);
  // Close a tile: drop the instance + everything keyed by it. The TileHost
  // unmounts its body (TerminalTile's cleanup kills/detaches the PTY).
  const closeTile = useCallback((id: string) => {
    unmarkBackgroundTile(id);
    setTiles((ts) => ts.filter((t) => t.id !== id));
    setBrowserOpenReqs((m) => {
      if (!(id in m)) return m;
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    setEditorTabs((m) => {
      if (!(id in m)) return m;
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    setAgentTitles((m) => {
      if (!(id in m)) return m;
      const { [id]: _t, ...rest } = m;
      return rest;
    });
  }, []);

  // Frames — colored comment boxes for grouping, each optionally bound to a
  // worktree / workspace folder / remote host. frames/frameOf each expose a
  // synchronously-readable ref (updated in the setter — see useStateWithRef).
  const [frames, setFrames, framesRef] = useStateWithRef<FrameState[]>(initial.frames);
  // Re-resolve a frame's workspaceRoot when it's null but the folder now has a
  // `.hivemind/` (opened before `hive init` → persisted null → Issues showed
  // "No workspace" forever). Run once on load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const todo = framesRef.current.filter(
        (f) => f.workspacePath && !f.workspacePath.startsWith("ssh://") && !f.workspaceRoot,
      );
      for (const f of todo) {
        try {
          const proj = await window.hive.resolveProject(f.workspacePath!);
          if (cancelled || !proj.root) continue;
          setFrames((fs) => fs.map((x) => (x.id === f.id ? { ...x, workspaceRoot: proj.root } : x)));
        } catch { /* unreadable path — leave as-is */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Explicit tile→frame membership (see PersistedLayout.frameOf). Authoritative
  // for auto-fit, parenting, and the chip strip — geometry never decides it.
  const [frameOf, setFrameOf, frameOfRef] = useStateWithRef<Record<string, string>>(initial.frameOf ?? {});
  // The frame the user most recently touched (spawned into / dragged). The
  // collision-separation pass keeps THIS frame fixed and pushes neighbours.
  const lastActiveFrameRef = useRef<string | null>(null);
  const repoPathRef = useRef(repoPath);
  useEffect(() => { repoPathRef.current = repoPath; }, [repoPath]);
  const rootRef = useRef(root);
  useEffect(() => { rootRef.current = root; }, [root]);
  // pushToast is defined far below (depends on dismissToast). bind/unbind are
  // declared above it, so reach it through a ref populated by an effect.
  const pushToastRef = useRef<((t: { tileId: string; label: string; status: TileStatusKind }) => void) | null>(null);
  // Selected frame — F2 / bring-to-front / spawn target read the ref.
  const [selectedFrameId, setSelectedFrameId, selectedFrameIdRef] = useStateWithRef<string | null>(null);

  // Latest viewport mutated on every pan tick (cheap — ref, no re-render);
  // committed to state at onMoveEnd so the canvas-layout persist effect picks it
  // up. Reload restores via react-flow's defaultViewport.
  const currentViewportRef = useRef<Viewport>(canvasInitial.viewport ?? DEFAULT_VIEWPORT);
  const [viewport, setViewport] = useState<Viewport>(canvasInitial.viewport ?? DEFAULT_VIEWPORT);

  // Reload when the repo changes — each repo has its own workspace + view
  // layouts. Skip on first mount (initial values already came from the memos).
  const lastRepoRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRepoRef.current === undefined) {
      lastRepoRef.current = persistKey;
      return;
    }
    if (lastRepoRef.current === persistKey) return;
    lastRepoRef.current = persistKey;
    const next = loadLayout(persistKey);
    const nextCanvas = loadCanvasLayout(persistKey);
    setSizes(nextCanvas.sizes);
    setPositions(nextCanvas.positions);
    setFrames(next.frames);
    setTileNames(next.tileNames ?? {});
    setTiles(next.tiles ?? []);
    setEditorTabs(next.editorTabs ?? {});
    setFrameOf(next.frameOf ?? {});
    if (nextCanvas.viewport) { currentViewportRef.current = nextCanvas.viewport; setViewport(nextCanvas.viewport); }
  }, [persistKey]);

  // Persist — trailing-debounced (250ms) so a drag's per-drop setPositions
  // doesn't JSON.stringify a blob on the main thread per commit; flushed on
  // repo switch (under the old key), unmount and beforeunload by
  // useDebouncedSave (the ONE mechanism every layout blob uses). Two blobs, two
  // triggers: the core blob rewrites on structural edits only — a pan/drop
  // touches just the canvas view's geometry blob. The core write mirrors the
  // geometry current at that moment (downgrade safety — see canvas-persistence).
  const coreSnap = useMemo(() => ({ frames, tileNames, tiles, editorTabs, frameOf }), [frames, tileNames, tiles, editorTabs, frameOf]);
  const geometry = useMemo(() => ({ positions, sizes, viewport }), [positions, sizes, viewport]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  useDebouncedSave(persistKey, coreSnap, useCallback((key: string, v: typeof coreSnap) => saveLayout(key, { ...v, legacy: geometryRef.current }), []));
  useDebouncedSave(persistKey, geometry, useCallback((key: string, v: typeof geometry) => saveViewLayout(CANVAS_LAYOUT, key, v), []));

  // Viewport-focus request: resolve the target's CENTER from our own state
  // (positions/sizes/frames) and hand absolute coords to <FocusOnTile>. Works
  // even when the node hasn't been DOM-measured yet or is culled off-screen.
  const [focusReq, setFocusReq] = useState<FocusReq>(null);
  const focusTile = useCallback(
    (id: string, opts?: { exact?: boolean }) => {
      const frame = framesRef.current.find((f) => f.id === id);
      let cx: number, cy: number, w: number, h: number;
      if (frame) {
        cx = frame.x + frame.w / 2;
        cy = frame.y + frame.h / 2;
        w = frame.w;
        h = frame.h;
      } else {
        const p = positionsRef.current[id];
        if (!p) return;
        const s = sizesRef.current[id] ?? defaultTileSize(id);
        cx = p.x + s.width / 2;
        cy = p.y + s.height / 2;
        w = s.width;
        h = s.height;
      }
      setFocusReq((prev) => ({ id, cx, cy, w, h, n: (prev?.n ?? 0) + 1, exact: opts?.exact }));
    },
    [],
  );

  // Frame CRUD + opt-in arrange + the reactive auto-fit effect. See useFrameOps.
  const {
    addFrame, updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, moveFrame, bringFrameToFront,
  } = useFrameOps({
    repoPath, positions, sizes, tiles, frameOf,
    framesRef, tilesRef, frameOfRef, positionsRef, sizesRef, lastActiveFrameRef,
    setFrames, setPositions, focusTile,
  });

  // Worktree + workspace-zone lifecycle (IPC, in-flight guard, detach confirm).
  const {
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace, bindRemote,
  } = useWorktrees({
    framesRef, tilesRef, positionsRef, sizesRef, frameOfRef, repoPathRef,
    lastActiveFrameRef, pushToastRef, setFrames, setFrameOf, setSelectedFrameId,
    focusTile, closeTile,
  });

  // Topmost-frame-wins point membership for drops (pure — see frameAtPoint).
  const sortedFrames = useMemo(() => [...frames].sort((a, b) => b.z - a.z), [frames]);
  const parentFrameOf = useCallback(
    (cx: number, cy: number): { parentId: string; fx: number; fy: number } | null => {
      const r = frameAtPoint(sortedFrames, cx, cy);
      return r ? { parentId: r.id, fx: r.x, fy: r.y } : null;
    },
    [sortedFrames],
  );

  // Which tile ids fall inside each frame — drives the chip strip in FrameNode.
  const frameTiles = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of tiles) {
      const fid = frameOf[t.id];
      if (!fid) continue;
      const arr = map.get(fid) ?? [];
      arr.push(t.id);
      map.set(fid, arr);
    }
    return map;
  }, [frameOf, tiles]);
  // Frame-chip names: rename / static only — NOT the live agent OSC title (it
  // churns ~every 600ms while streaming and would rebuild the node array).
  const framesChipNames = useMemo(() => ({ ...tileNames }), [tileNames]);

  // ── view-agnostic listing (Layers rail, tab strip, 3D labels …) ────────────
  const layerFrames: LayerFrame[] = useMemo(
    () => frames.map((f) => ({
      id: f.id, title: f.title, color: f.color,
      parentFrameId: f.parentFrameId, branch: f.parentFrameId ? f.branch : undefined,
      remote: isRemote(f.workspacePath),
    })),
    [frames],
  );
  const layerTiles: LayerTile[] = useMemo(() => {
    const out: LayerTile[] = [];
    const fo = frameOf;
    for (const t of tiles) {
      // Same effective-repo rule as the surface builder: a worktree/workspace
      // frame can supply the repo even when the workspace has no global one.
      const owner = fo[t.id] ? frames.find((f) => f.id === fo[t.id]) : undefined;
      const effRepo = owner?.worktreePath ?? owner?.workspacePath ?? repoPath ?? null;
      if ((t.kind === "editor" || t.kind === "diff") && !effRepo) continue;
      const kind: LayerTile["kind"] = t.kind === "shell" ? "terminal" : t.kind;
      const agent = t.kind === "claude" ? (agentForCmd(t.cmd)?.id ?? "claude") : undefined;
      out.push({ id: t.id, kind, name: tileNames[t.id] ?? agentTitles[t.id] ?? t.label, frameId: fo[t.id] ?? null, agent });
    }
    return out;
  }, [tiles, repoPath, frameOf, frames, tileNames, agentTitles]);

  // ── active view (plugin) ───────────────────────────────────────────────────
  // The stored id (view-mode-store, shared with Settings ▸ View and ⌘E) is a
  // plain string so a view can be added/removed without a schema change;
  // resolveViewId maps unknown ids to the fallback.
  const activeViewId = resolveViewId(useViewMode());
  // Crash bookkeeping: which view failed (+ why) and a retry counter that
  // remounts the boundary. A failure in a non-fallback view auto-switches to the
  // fallback with a toast; a failure IN the fallback shows the failure panel.
  const [viewFailure, setViewFailure] = useState<{ id: string; error: Error } | null>(null);
  const [viewAttempt, setViewAttempt] = useState(0);
  useEffect(() => { setViewFailure(null); }, [activeViewId]); // leaving a crashed view clears its record
  const switchView = useCallback((id: string) => {
    setViewFailure(null);
    setViewMode(resolveViewId(id));
  }, []);
  const onViewError = useCallback((id: string, error: Error) => {
    const fallback = resolveViewId(FALLBACK_VIEW_ID);
    if (fallback && fallback !== id) {
      toast.error(`The ${getView(id)?.label ?? id} view crashed — switched to ${getView(fallback)?.label ?? fallback}. Your tiles are untouched.`);
      setViewMode(fallback);
    } else {
      setViewFailure({ id, error });
    }
  }, []);

  // Permission mode the next Claude spawn launches in. Verified flag values
  // (code.claude.com/docs cli-reference): default | acceptEdits | plan | auto |
  // dontAsk | bypassPermissions. Persisted so it survives restarts.
  const [claudeMode] = useState<string>(
    () => localStorage.getItem("hivemind:claude-mode") || "default",
  );
  useEffect(() => { localStorage.setItem("hivemind:claude-mode", claudeMode); }, [claudeMode]);
  // Default model for new claude spawns (a Settings picker can set it later).
  const [claudeModel] = useState<string>(
    () => localStorage.getItem("hivemind:claude-model") || "default",
  );
  // Which agent the tool island's spawn button creates (claude / codex / …).
  const [agentSel, setAgentSel] = useState<string>(
    () => localStorage.getItem("hivemind:agent-sel") || "claude",
  );
  const agentSelRef = useRef(agentSel);
  useEffect(() => { agentSelRef.current = agentSel; localStorage.setItem("hivemind:agent-sel", agentSel); }, [agentSel]);

  // Monotonic session counter — `xs.length + 1` produced DUPLICATE labels
  // (#3, #3) after kill+respawn. This only ever increases.
  const claudeSeqRef = useRef(0);
  // Spawn-target picker: when 2+ workspaces (base + workspace-zone frames) live
  // on the canvas, ask WHERE a new claude should run instead of guessing.
  const [spawnPick, setSpawnPick] = useState<({ kind: TileKind } & SpawnOpts) | null>(null);
  const browserReqSeq = useRef(0);
  const [browserOpenReqs, setBrowserOpenReqs] = useState<Record<string, { url: string; seq: number }>>({});
  // Text awaiting a claude target — set when something wants to deliver a prompt
  // ("Work on this", diff "send review") and 1+ claude tiles exist.
  const [claudePick, setClaudePick] = useState<{ text: string } | null>(null);
  // Frame awaiting a remote (ssh://) bind — set when FrameNode / the rail fires
  // `hivemind:attach-remote`; the modal connects, browses, and binds the uri.
  const [remoteAttach, setRemoteAttach] = useState<string | null>(null);
  useEffect(() => {
    const onAttach = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId: string }>).detail?.frameId;
      if (fid) setRemoteAttach(fid);
    };
    window.addEventListener("hivemind:attach-remote", onAttach as EventListener);
    return () => window.removeEventListener("hivemind:attach-remote", onAttach as EventListener);
  }, []);

  // Git commit/sync modal — open for a specific repo (a frame's worktree /
  // workspace / base repo), via `hivemind:frame-git` {frameId | repoPath}.
  const [gitModalRepo, setGitModalRepo] = useState<string | null>(null);
  useEffect(() => {
    const onGit = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId?: string; repoPath?: string }>).detail;
      if (fid?.repoPath) { setGitModalRepo(fid.repoPath); return; }
      if (fid?.frameId) {
        const f = framesRef.current.find((x) => x.id === fid.frameId);
        const repo = f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
        if (repo) setGitModalRepo(repo);
      }
    };
    window.addEventListener("hivemind:frame-git", onGit as EventListener);
    return () => window.removeEventListener("hivemind:frame-git", onGit as EventListener);
  }, []);

  // Tile spawning + in-frame placement. See useSpawn.
  const { spawnTile, spawnClaude, spawnAgent, spawnVis, spawnInto, frameOpen, openPlanReview, hcpSpawnAgent } = useSpawn({
    repoPath, claudeMode, claudeModel,
    positionsRef, sizesRef, tilesRef, frameOfRef, framesRef, selectedFrameIdRef,
    selectedTileIdRef, repoPathRef, rootRef, lastActiveFrameRef, claudeSeqRef,
    setFrameOf, setPositions, setSelectedTileId, setFocusReq, setFrames,
    setSelectedFrameId, setTiles, setSpawnPick, focusTile,
  });

  // Rail context-menu actions — the SAME surface the on-canvas frame header
  // exposes, reused from the Layers rail in every view.
  const gitPushMut = useGitPush();
  const gitPullMut = useGitPull();
  const repoOfFrame = useCallback((frameId: string): string | null => {
    const f = framesRef.current.find((x) => x.id === frameId);
    return f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
  }, []);
  const frameActions = useMemo(() => ({
    onOpenInFrame: (frameId: string, kind: string) => frameOpen(frameId, kind),
    onCreateWorktree,
    onAttachWorktree,
    onBindWorkspace: (frameId: string) => bindWorkspace(frameId),
    onAttachRemote: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId } })),
    onArrange: (frameId: string, mode: "columns" | "rows" | "grid") => arrangeFrame(frameId, mode),
    onRename: (frameId: string, title: string) => updateFrameTitle(frameId, title),
    onColor: (frameId: string, color: string) => updateFrameColor(frameId, color),
    onDelete: (frameId: string) => deleteFrame(frameId),
    onGit: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:frame-git", { detail: { frameId } })),
    onPush: (frameId: string) => { const r = repoOfFrame(frameId); if (r) gitPushMut.mutate({ repoPath: r }); },
    onPull: (frameId: string) => { const r = repoOfFrame(frameId); if (r) gitPullMut.mutate({ repoPath: r }); },
    repoPathForFrame: (frameId: string): string | null => {
      const f = framesRef.current.find((x) => x.id === frameId);
      return f?.worktreePath ?? f?.workspacePath ?? repoPath ?? null;
    },
    // Depend on the stable `.mutate` refs, NOT the mutation objects — those are
    // fresh on every isPending tick and would re-render every rail consumer.
  }), [frameOpen, onCreateWorktree, onAttachWorktree, bindWorkspace, arrangeFrame, updateFrameTitle, updateFrameColor, deleteFrame, repoPath, repoOfFrame, gitPushMut.mutate, gitPullMut.mutate]);
  const openFileFromTerminal = useCallback((sourceTileId: string, path: string) => {
    const sourceFrameId = frameOfRef.current[sourceTileId] ?? selectedFrameIdRef.current;
    const existing = tilesRef.current.find((t) => (
      (t.kind === "editor" || t.kind === "workbench") &&
      (!sourceFrameId || frameOfRef.current[t.id] === sourceFrameId)
    ));
    if (existing) {
      openFileInTile(existing.id, path);
      setTimeout(() => { setSelectedTileId(existing.id); focusTile(existing.id); }, 0);
      return;
    }
    spawnTile("editor", sourceFrameId ?? null, {});
  }, [openFileInTile, focusTile, spawnTile]);

  const openUrlInBrowser = useCallback((sourceTileId: string, url: string) => {
    const sourceFrameId = frameOfRef.current[sourceTileId] ?? selectedFrameIdRef.current;
    const existing = tilesRef.current.find((t) => (
      t.kind === "browser" && (!sourceFrameId || frameOfRef.current[t.id] === sourceFrameId)
    ));
    if (existing) {
      const browserFrameId = frameOfRef.current[existing.id] ?? null;
      const seq = ++browserReqSeq.current;
      setBrowserOpenReqs((m) => ({ ...m, [existing.id]: { url, seq } }));
      // Defer selection past the click-bubble: onNodeClick fires on the terminal
      // node after our handler and would re-select it, clobbering our selection.
      setTimeout(() => {
        if (browserFrameId) setSelectedFrameId(browserFrameId);
        setSelectedTileId(existing.id);
        focusTile(existing.id);
      }, 0);
      return;
    }
    spawnTile("browser", sourceFrameId ?? null, { url });
  }, [focusTile, spawnTile]);

  // Plan review: an agent hit ExitPlanMode → main's plan-bridge pushed the plan.
  useEffect(() => {
    const offOpen = window.hive.onPlanReviewOpen((p) => {
      openPlanReview({ requestId: p.requestId, plan: p.plan, cwd: p.cwd, agentTileId: p.tileId });
    });
    const offAbort = window.hive.onPlanReviewAbort((requestId) => {
      const tile = tilesRef.current.find((t) => t.kind === "planReview" && t.review?.requestId === requestId);
      if (tile) closeTile(tile.id);
    });
    return () => { offOpen(); offAbort(); };
  }, [openPlanReview, closeTile]);

  // HCP control plane: main forwards a workspace verb (e.g. tile.spawn_agent
  // from an agent's hive MCP). Execute it and reply with the result/error.
  useEffect(() => {
    const off = window.hive.onHcpCommand(async (cmd) => {
      try {
        const p = (cmd.params ?? {}) as Record<string, unknown>;
        switch (cmd.method) {
          case "tile.spawn_agent": {
            const tileId = hcpSpawnAgent(p as { agent?: string; prompt?: string; frame?: string; mode?: string; model?: string; callerTile?: string; background?: boolean; name?: string });
            await window.hive.hcpResult(cmd.id, true, { tileId });
            break;
          }
          case "tile.list": {
            // Resolve an optional frame filter (id → title → path basename →
            // title substring), same precedence as spawn's frame targeting.
            const resolveFrameId = (q: string): string | undefined => {
              const fs = framesRef.current;
              const lq = q.toLowerCase();
              const base = (pp?: string) => pp?.split("/").filter(Boolean).pop()?.toLowerCase();
              return (
                fs.find((f) => f.id === q) ??
                fs.find((f) => f.title.toLowerCase() === lq) ??
                fs.find((f) => base(f.worktreePath) === lq || base(f.workspacePath) === lq) ??
                fs.find((f) => f.title.toLowerCase().includes(lq))
              )?.id;
            };
            const filterId = p.frame ? resolveFrameId(String(p.frame)) : undefined;
            const mapTile = (t: typeof tilesRef.current[number]) => ({
              tileId: t.id, kind: t.kind, label: t.label, status: statusOf(t.id),
            });
            const groupOf = (f: FrameState) => ({
              frameId: f.id,
              title: f.title,
              repo: f.worktreePath ?? f.workspacePath ?? null,
              branch: f.branch ?? null,
              tiles: tilesRef.current.filter((t) => frameOfRef.current[t.id] === f.id).map(mapTile),
            });
            if (filterId) {
              const f = framesRef.current.find((fr) => fr.id === filterId)!;
              await window.hive.hcpResult(cmd.id, true, { frames: [groupOf(f)], loose: [] });
              break;
            }
            const frameIds = new Set(framesRef.current.map((f) => f.id));
            const frames = framesRef.current.map(groupOf).filter((g) => g.tiles.length > 0);
            const loose = tilesRef.current
              .filter((t) => { const fid = frameOfRef.current[t.id]; return !fid || !frameIds.has(fid); })
              .map(mapTile);
            await window.hive.hcpResult(cmd.id, true, { frames, loose });
            break;
          }
          case "tile.list_frames": {
            const frames = framesRef.current.map((f) => ({
              id: f.id,
              title: f.title,
              repo: f.worktreePath ?? f.workspacePath ?? null,
              branch: f.branch ?? null,
              tiles: tilesRef.current.filter((t) => frameOfRef.current[t.id] === f.id).length,
            }));
            await window.hive.hcpResult(cmd.id, true, { frames });
            break;
          }
          case "tile.focus": {
            const id = String(p.tileId ?? "");
            setSelectedTileId(id);
            focusTile(id);
            await window.hive.hcpResult(cmd.id, true, { ok: true });
            break;
          }
          case "tile.close": {
            closeTile(String(p.tileId ?? ""));
            await window.hive.hcpResult(cmd.id, true, { ok: true });
            break;
          }
          case "review.open": {
            // The review tile replies (hcpResult) on the user's decision.
            openPlanReview({ plan: String(p.plan ?? ""), cwd: String(p.cwd ?? ""), hcpCmdId: cmd.id });
            break;
          }
          default:
            await window.hive.hcpResult(cmd.id, false, undefined, `unknown renderer verb: ${cmd.method}`);
        }
      } catch (e) {
        await window.hive.hcpResult(cmd.id, false, undefined, (e as Error)?.message ?? "renderer error");
      }
    });
    return off;
  }, [hcpSpawnAgent, focusTile, closeTile]);

  // HCP pipes → animated data-flow edges. Add on connect; on disconnect remove
  // the one edge (dst set) or all of src's edges (dst null).
  useEffect(() => {
    return window.hive.onHcpPipe((ev) => {
      setPipes((cur) => {
        if (ev.connected && ev.dst) {
          if (cur.some((p) => p.src === ev.src && p.dst === ev.dst)) return cur;
          return [...cur, { src: ev.src, dst: ev.dst }];
        }
        return cur.filter((p) => p.src !== ev.src || (ev.dst != null && p.dst !== ev.dst));
      });
    });
  }, []);

  // HCP spawn wires → dashed parentage edges.
  useEffect(() => {
    return window.hive.onHcpSpawn((ev) => {
      setSpawnLinks((cur) => {
        if (ev.connected && ev.parent) {
          if (cur.some((l) => l.parent === ev.parent && l.child === ev.child)) return cur;
          return [...cur, { parent: ev.parent, child: ev.child }];
        }
        return cur.filter((l) => l.child !== ev.child && l.parent !== ev.child);
      });
    });
  }, []);

  // HCP "wait" states (a supervised worker blocked on its parent's approval) →
  // override the scrape on the status bus.
  useEffect(() => {
    return window.hive.onHcpWait((ev) => {
      setWaitStatus(ev.tileId, (ev.status as TileStatusKind | null) ?? null);
    });
  }, []);
  // HCP subagent lifecycle → keep a tile "working" while it has in-flight Tasks.
  useEffect(() => {
    return window.hive.onHcpSubagent((ev) => { setSubagentBusy(ev.tileId, ev.busy); });
  }, []);
  // HCP "needs you" (claude's Notification hook) → soft status override.
  useEffect(() => {
    return window.hive.onHcpNotify((ev) => { setNotify(ev.tileId, ev.status as TileStatusKind); });
  }, []);
  // HCP turn state — hook-driven working/idle, authoritative over the scrape.
  useEffect(() => {
    return window.hive.onHcpTurnState((ev) => { setTurnState(ev.tileId, ev.state); });
  }, []);

  // Plan-review wait: while a planReview tile is open for an agent, mark that
  // agent "waiting: review" (cleared when the plan tile closes).
  const planAgentsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set<string>();
    for (const t of tiles) if (t.kind === "planReview" && t.review?.agentTileId) now.add(t.review.agentTileId);
    for (const a of now) if (!planAgentsRef.current.has(a)) setWaitStatus(a, "plan_review");
    for (const a of planAgentsRef.current) if (!now.has(a)) setWaitStatus(a, null);
    planAgentsRef.current = now;
  }, [tiles]);

  // Deliver a prompt to claude with a TARGET PICKER. 0 claude tiles → spawn a
  // new claude carrying the prompt; 1+ → picker (the chosen tile, or "New").
  const deliverToClaude = useCallback((text: string, target: "new" | string) => {
    if (target === "new") { spawnClaude(undefined, text); return; }
    window.dispatchEvent(new CustomEvent("hivemind:send-to-claude", { detail: { text, target } }));
    setSelectedTileId(target);
    focusTile(target);
  }, [spawnClaude, focusTile]);
  useEffect(() => {
    const onDeliver = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      const claudes = tilesRef.current.filter((t) => t.kind === "claude");
      if (claudes.length === 0) { spawnClaude(undefined, text); return; }
      setClaudePick({ text });
    };
    window.addEventListener("hivemind:deliver-to-claude", onDeliver as EventListener);
    return () => window.removeEventListener("hivemind:deliver-to-claude", onDeliver as EventListener);
  }, [spawnClaude]);

  // Spawn the island's CURRENTLY-selected agent (key "2").
  const spawnSelectedAgent = useCallback(() => {
    const a = agentById(agentSelRef.current) ?? AGENTS[0]!;
    spawnAgent(a);
  }, [spawnAgent]);
  const spawnBrowser = useCallback(() => spawnInto("browser"), [spawnInto]);

  // Keyboard shortcuts + menu event listeners. See useCanvasShortcuts.
  useCanvasShortcuts({
    repoPath, spawnClaude, spawnSelectedAgent, spawnVis, spawnBrowser, addFrame, frameOpen, focusTile,
    setSelectedTileId, setFocusModeReq, selectedTileIdRef, selectedFrameIdRef,
    focusModeNonceRef, tilesRef,
  });

  // Pin state derived from tiles. Pinning captures the tile's SCREEN rect so the
  // floating panel opens where the tile is; unpinning keeps the anchor/size.
  const pinnedIds = useMemo(() => new Set(tiles.filter((t) => t.pinned).map((t) => t.id)), [tiles]);
  const togglePin = useCallback((id: string, rect: PinRect) => {
    setTiles((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      if (t.pinned) return { ...t, pinned: false };
      const anchor = clampAnchor(
        { sx: rect.sx, sy: rect.sy },
        { w: rect.w, h: rect.h },
        { w: window.innerWidth, h: window.innerHeight },
      );
      return { ...t, pinned: true, pinAnchor: anchor, pinSize: { w: rect.w, h: rect.h } };
    }));
  }, [setTiles]);
  const onPinChange = useCallback((id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => {
    setTiles((ts) => ts.map((t) => (t.id === id
      ? { ...t, ...(patch.anchor ? { pinAnchor: patch.anchor } : {}), ...(patch.size ? { pinSize: patch.size } : {}) }
      : t)));
  }, [setTiles]);
  // A pinned panel lives in SCREEN pixels — re-clamp every pin on window resize
  // so a shrunk window can't strand one off-screen (the anchor is persisted).
  useEffect(() => {
    const reclamp = () => {
      const win = { w: window.innerWidth, h: window.innerHeight };
      setTiles((ts) => {
        let moved = false;
        const next = ts.map((t) => {
          if (!t.pinned || !t.pinAnchor) return t;
          const size = t.pinSize ?? { w: 380, h: 260 };
          const c = clampAnchor(t.pinAnchor, size, win);
          if (c.sx === t.pinAnchor.sx && c.sy === t.pinAnchor.sy) return t;
          moved = true;
          return { ...t, pinAnchor: c };
        });
        return moved ? next : ts;
      });
    };
    reclamp(); // also rescues pins already stranded by a resize while closed
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [setTiles]);

  // Theme is a global app pref persisted by theme-store; push it into the DOM once.
  useEffect(() => { applyTheme(); }, []);

  // ── auto-pan to newly-spawned tiles ───────────────────────────────────────
  // Framed spawns are already selected+focused by placeInFrame (the single
  // authority); fire here only for a LOOSE tile so we don't double-animate.
  const prevExtrasLen = useRef(tiles.length);
  useEffect(() => {
    if (tiles.length > prevExtrasLen.current) {
      const last = tiles[tiles.length - 1];
      if (last && !frameOfRef.current[last.id]) {
        setSelectedTileId(last.id);
        focusTile(last.id);
      }
    }
    prevExtrasLen.current = tiles.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, focusTile]);

  // herdr-style agent awareness: status → in-app toast + OS notification, with
  // done-unseen tracking + selection-based suppression. See useAgentAwareness.
  const { toasts, dismissToast, markSeen, selectedTileIdsRef } = useAgentAwareness({
    pushToastRef, frameOfRef, framesRef,
  });

  // Canvas drop handling (membership on drop, frame moves). The canvas view
  // strips its `.canvas-dragging` class before delegating, so no-op here.
  const noopClearDragging = useCallback(() => {}, []);
  const handleNodeDragStop = useNodeDragStop({
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, clearDragging: noopClearDragging,
  });
  const resetCanvas = useCallback(() => {
    setSizes({}); setPositions({}); setFrames([]); setTiles([]); setEditorTabs({}); setFrameOf({});
  }, []);

  // ── the shared tile surfaces (bodies) — rendered ONCE by the TileHost ─────
  // agentTitles intentionally NOT an input: a live title change must not
  // re-render every tile body (cursor-flicker + focus loss while streaming).
  const surfaces = useMemo(() => buildTileSurfaces({
    repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, editorTabs, browserOpenReqs, tileNames,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, renameTile, setAgentTitle,
    onTogglePin: togglePin,
  }), [
    repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, editorTabs, browserOpenReqs, tileNames,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, renameTile, setAgentTitle, togglePin,
  ]);

  // ── what the active view receives ─────────────────────────────────────────
  const links = useMemo(() => ({ pipes, spawnLinks }), [pipes, spawnLinks]);
  const model: WorkspaceViewModel = useMemo(() => ({
    repoPath, root, cwd, layoutKey: persistKey,
    tiles, frames, frameOf, tileNames, agentTitles, selectedTileId, selectedFrameId,
    layerTiles, layerFrames, frameActions, links,
  }), [repoPath, root, cwd, persistKey, tiles, frames, frameOf, tileNames, agentTitles, selectedTileId, selectedFrameId, layerTiles, layerFrames, frameActions, links]);
  const commands: WorkspaceCommands = useMemo(() => ({
    selectTile: setSelectedTileId,
    selectFrame: setSelectedFrameId,
    focusTile,
    closeTile,
    spawnTile: (kind, frameId, opts) => spawnTile(kind, frameId, opts ?? {}),
    spawnVis,
    spawnClaude: () => spawnClaude(),
    addFrame,
  }), [setSelectedTileId, setSelectedFrameId, focusTile, closeTile, spawnTile, spawnVis, spawnClaude, addFrame]);

  // The canvas plugin's private runtime access (milestone-1 seam).
  const canvasRuntime: CanvasRuntime = useMemo(() => ({
    positions, sizes, currentViewportRef, setViewport,
    onNodeResizeCommit, handleNodeDragStop, resetCanvas,
    focusReq, focusModeReq, setFocusModeReq, focusModeNonceRef, selectedTileIdRef, selectedFrameIdRef,
    selectedTileIdsRef, markSeen, toasts, dismissToast,
    frameTiles, framesChipNames, updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, bringFrameToFront,
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace,
    pinnedIds, togglePin, onPinChange,
    agentSel, setAgentSel, spawnAgent, spawnBrowser, onInitWorkspace,
    updateAvailable, onUpgrade: () => onUpgrade?.(), upgrading,
  }), [
    positions, sizes, onNodeResizeCommit, handleNodeDragStop, resetCanvas, focusReq, focusModeReq,
    selectedTileIdRef, selectedFrameIdRef, selectedTileIdsRef, markSeen, toasts, dismissToast, frameTiles, framesChipNames,
    updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, bringFrameToFront,
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace,
    pinnedIds, togglePin, onPinChange, agentSel, spawnAgent, spawnBrowser, onInitWorkspace, updateAvailable, onUpgrade, upgrading,
  ]);

  return (
    <CanvasRuntimeContext.Provider value={canvasRuntime}>
    <div className="relative h-full w-full flex flex-col" data-active-view={activeViewId ?? ""}>
      {/* Live wallpaper — fixed full-window layer behind ALL app content (z-index
          -1), so it shows through every view AND the panels beside it. */}
      <Wallpaper />
      {/* Custom OVERLAY media — user's transparent foreground plane OVER the
          tiles. Fixed full-window + pointer-events:none. */}
      <CanvasOverlay />
      {/* The active view plugin, behind its crash boundary. Bodies are NOT in
          this subtree (TileHost below), so a view crash or switch never touches
          a live session. */}
      <ViewHost
        viewId={activeViewId}
        attempt={viewAttempt}
        props={{ model, commands }}
        onError={onViewError}
        failed={viewFailure && viewFailure.id === activeViewId ? viewFailure.error : null}
        onSwitch={switchView}
        onRetry={() => { setViewFailure(null); setViewAttempt((n) => n + 1); }}
      />
      {/* Shared-layer selection: a body's native pointerdown selects its tile
          (React synthetic events from a portaled body never reach a view's own
          handlers — see tile-host.tsx). */}
      <TileHost surfaces={surfaces} selectedTileId={selectedTileId} onSurfacePointerDown={setSelectedTileId} />

      {/* Spawn-target picker — asks WHERE a new agent runs when 2+ workspaces
          are open. Lives here (not in a view) so spawning works the same in
          every view. */}
      {spawnPick && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60]">
          <div className="hm-island rounded-xl p-1.5 min-w-[240px] pointer-events-auto">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">
              Spawn claude in
            </div>
            {/* Each repo frame followed by its worktree children — reads as a tree. */}
            {frames
              .filter((f) => !f.parentFrameId)
              .flatMap((p) => [p, ...frames.filter((c) => c.parentFrameId === p.id)])
              .map((f) => {
                const isSel = f.id === selectedFrameId;
                const isWt = !!f.parentFrameId;
                return (
                  <button
                    key={f.id}
                    autoFocus={isSel}
                    onClick={() => { spawnTile(spawnPick.kind, f.id, { mode: spawnPick.mode, work: spawnPick.work, url: spawnPick.url, agent: spawnPick.agent }); setSpawnPick(null); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-colors ${
                      isSel ? "bg-[var(--color-bg3)] ring-1 ring-[var(--color-select)]" : ""
                    }`}
                    style={isWt ? { paddingLeft: 20 } : undefined}
                  >
                    <span aria-hidden className="size-2 rounded-full shrink-0" style={{ background: f.color }} />
                    <span className="truncate">{f.title}</span>
                    <span className="ml-auto text-[10px] text-[var(--color-fg3)]">
                      {isSel ? "selected" : isWt ? "worktree" : "workspace"}
                    </span>
                  </button>
                );
              })}
            <button
              onClick={() => setSpawnPick(null)}
              className="w-full text-left px-2 py-1 mt-0.5 rounded-md text-[11px] text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] transition-colors"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      <RemoteConnectModal
        open={remoteAttach !== null}
        onClose={() => setRemoteAttach(null)}
        onPick={(uri) => { if (remoteAttach) bindRemote(remoteAttach, uri); setRemoteAttach(null); }}
      />
      {claudePick && (
        // z above the tile fullscreen overlay (z-[9999]) so the picker shows ON
        // TOP of a fullscreened diff/editor instead of behind it.
        <div className="fixed inset-0 z-[10000] grid place-items-center" onClick={() => setClaudePick(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative w-[340px] max-w-[90vw] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] shadow-2xl p-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center px-2 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">
                Send to claude
              </span>
              <button
                onClick={() => setClaudePick(null)}
                className="ml-auto size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] transition-colors text-[12px] leading-none"
                aria-label="cancel"
                title="cancel (Esc)"
              >
                ×
              </button>
            </div>
            {tiles.filter((t) => t.kind === "claude").map((t) => {
              const name = tileNames[t.id] ?? agentTitles[t.id] ?? t.label;
              const frame = frames.find((f) => f.id === frameOf[t.id]);
              return (
                <button
                  key={t.id}
                  onClick={() => { deliverToClaude(claudePick.text, t.id); setClaudePick(null); }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] cursor-pointer"
                >
                  <AgentIcon id="claude" size={13} className="shrink-0 text-[var(--color-fg3)]" />
                  <span className="truncate flex-1">{name}</span>
                  {frame && <span className="shrink-0 text-[10px] text-[var(--color-fg3)]">{frame.title}</span>}
                </button>
              );
            })}
            <div className="my-1 border-t border-[var(--color-line2)]" />
            <button
              onClick={() => { deliverToClaude(claudePick.text, "new"); setClaudePick(null); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
            >
              <span className="shrink-0 grid place-items-center size-3.5 text-[var(--color-fg3)]">+</span>
              <span className="flex-1">New claude</span>
            </button>
            <button
              onClick={() => setClaudePick(null)}
              className="w-full text-left px-2 py-1 mt-0.5 rounded-md text-[11px] text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] transition-colors"
            >
              cancel
            </button>
          </div>
        </div>
      )}
      {/* Git commit/sync modal — opened per-frame via hivemind:frame-git, in
          every view. */}
      <GitCommitModal
        repoPath={gitModalRepo}
        open={gitModalRepo !== null}
        onOpenChange={(o) => { if (!o) setGitModalRepo(null); }}
      />
    </div>
    </CanvasRuntimeContext.Provider>
  );
}
