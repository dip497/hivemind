import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import { LayersPanel, type LayerTile, type LayerFrame } from "./LayersPanel";
import type { TileStatusKind } from "./agent-status-bus";
import { queueWork } from "./claude-bus";
import { FRAME_ROW_MAX, frameAtPoint } from "./frame-layout";
import { ToolIsland, ZoomIsland } from "./canvas-islands";
import { Toasts, CanvasEmptyState } from "./canvas-overlays";
import { nodeTypes } from "./canvas-nodes";
import {
  snapViewportCrisp,
  FocusMode,
  FocusOnTile,
  PanMomentum,
  SelectZoomReset,
  ViewportSnap,
  useTileFocus,
} from "./canvas-camera";
import type { TileKind } from "./tile-kinds";
import {
  loadLayout,
  saveLayout,
  defaultShell,
  WORKBENCH_TILE_ID,
  type TileInstance,
  type FrameState,
} from "./canvas-persistence";
import { useStateWithRef } from "./use-state-with-ref";
import { defaultTileSize, defaultSizeForKind } from "./canvas-sizing";
import { useWorktrees } from "./useWorktrees";
import { RemoteConnectModal } from "./components/RemoteConnectModal";
import { isRemote } from "../../shared/remote-uri";
import { AGENTS, AgentIcon, agentById, agentForCmd } from "./agents";
import { useSpawn } from "./useSpawn";
import { useFrameOps } from "./useFrameOps";
import { buildBaseNodes } from "./canvas-node-build";
import { useAgentAwareness } from "./useAgentAwareness";
import { useCanvasShortcuts } from "./useCanvasShortcuts";
import { useNodeDragStop } from "./useNodeDragStop";
import type { WorktreeEntry } from "../../shared/ipc";

// snapViewportCrisp moved to canvas-camera.tsx

// node wrappers + nodeTypes + useTileWheelZoom moved to canvas-nodes.tsx

// Stable references for props passed to <ReactFlow>. The xyflow perf guide
// (reactflow.dev/learn/advanced-use/performance) flags unmemoized object/array
// props as the #1 cause of re-renders during node movement — a fresh `edges={[]}`
// or inline `panOnDrag={[1,2]}` every render makes react-flow re-process its
// internal state each frame. Hoisting them to module scope makes the ref constant.
const EMPTY_EDGES: Edge[] = [];
const PAN_ON_DRAG = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };
// Snap on drop to an 8px grid (Figma's standard). The drop xyflow hands us is
// raw cursor; rounding to 8px means the tile travels a few px from cursor to
// grid — and because `.canvas-dragging` is removed SYNC on dragstop, the
// `.react-flow__node` 280ms transition (Linear-app ease-out-quint) animates
// that travel. THAT is the "smooth land" moment. Below ~4px the travel is too
// small to read as motion.
const SNAP_GRID: [number, number] = [8, 8];
const DEFAULT_VIEWPORT = { x: 16, y: 24, zoom: 1 };

interface Props {
  cwd: string;
  repoPath: string | null;
  /** Workspace root (.hivemind parent) — issues are keyed by this, not repoPath. */
  root?: string | null;
  /** When the launched folder has no .hivemind/, App provides this so the
   *  CanvasEmptyState can offer "Initialize workspace here…" (the old top-left
   *  switcher's job). Undefined when a workspace is already resolved. */
  onInitWorkspace?: () => void;
}


// Every tile on the canvas is an INSTANCE now (was: claude/shell instanced via
// `extras`, but editor/diff/issues were global singletons keyed off a fixed id
// + a `vis` boolean). Unifying them means each workspace frame can hold its own
// editor/diff/issues, and terminals are instances everywhere. claude + shell
// are unlimited per frame; editor/diff/issues are one-per-frame (spawn focuses
// the existing one if that frame already has it).
/** Kinds that are one-per-frame (spawn → focus existing). claude/shell are not. */
const SINGLETON_KINDS: ReadonlySet<TileKind> = new Set(["editor", "diff", "issues"]);



// tile sizing helpers + FRAME_* constants moved to canvas-sizing.ts

export function Canvas({ cwd, repoPath, root = null, onInitWorkspace }: Props) {
  // Bootstrapped from localStorage on first render (synchronous useState
  // initializer so we never flash an empty canvas before hydrating). Reloaded
  // when repoPath changes — see the effect below.
  const initial = useMemo(() => loadLayout(repoPath), [repoPath]);

  // Lazy-mount: nothing on screen until the user clicks a toggle — OR restored
  // from a prior session so a restart resumes where you left off. Avoids
  // mounting all three tiles + spawning a PTY + git ls-files just to look.
  // All open tiles, every kind, as instances. Replaces the old `vis` singletons
  // + `extras` list. Mirror to a ref so callbacks declared before later state
  // can read the latest list without re-creating on every change.
  const [tiles, setTiles, tilesRef] = useStateWithRef<TileInstance[]>(initial.tiles ?? []);
  // Files opened in each editor tile — tabs keyed by editor tile id (repo-
  // relative paths, deduped). Each editor instance has its own tab set.
  const [editorTabs, setEditorTabs] = useState<Record<string, string[]>>(initial.editorTabs ?? {});

  // Runtime per-tile dimension overrides. Initial size lives in the node
  // spec's style; once the user drags a NodeResizer corner, react-flow's
  // XYResizer fires a `dimensions` change which we capture here. Without
  // this, the useMemo-rebuilt node spec re-applies the old style.width/height
  // every render and the resize visually no-ops (we proved this via
  // playwright: onResize callback DID fire with 460→620 px, but
  // getBoundingClientRect still read 460 because style.width won the race).
  const [sizes, setSizes, sizesRef] = useStateWithRef<Record<string, { width: number; height: number }>>(initial.sizes);
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
  // Live agent session titles from the terminal OSC window-title (claude writes
  // a task summary there). NOT persisted — it's a moment-to-moment overlay that
  // a user rename (tileNames) takes precedence over. Cleared when a tile closes.
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
      // but our positions map is ABSOLUTE world coords (mkTile + the auto-fit
      // effect both assume absolute). Without converting, resizing a framed
      // tile from a top/left handle stored a relative coord as absolute → the
      // tile jumped left/up by the frame offset on the next render, and the
      // frame mis-grew. Add the frame origin back when the tile lives in one.
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
    // Frame resize is handled reactively by the auto-fit effect — committing
    // the new size/position above triggers it. No manual frame-grow here.
  }, []);

  // Same pattern for positions — useMemo rebuilds nodes with hardcoded x/y
  // from the layout loop, so dragged-then-released tiles would snap back
  // without this override map. Populated by onNodeDragStop.
  const [positions, setPositions, positionsRef] = useStateWithRef<Record<string, { x: number; y: number }>>(initial.positions);
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

  // Manual tile selection (react-flow's click-select is dead in our config —
  // see the note at the original declaration site below). Declared here so
  // openFile can select the editor tile when a file opens.
  const [selectedTileId, setSelectedTileId, selectedTileIdRef] = useStateWithRef<string | null>(null);
  // Keyboard gate: a tile only takes input while selected. `tile-locked`'s
  // pointer-events:none blocks the mouse but NOT the keyboard, so a focused
  // input (CodeMirror, an issue field, …) keeps eating keystrokes after its
  // tile is deselected. Blur whatever's focused inside a now-unselected tile.
  // (Terminals also self-gate via xterm disableStdin.)
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return;
    const node = active.closest(".react-flow__node");
    if (!node) return;
    if (!selectedTileId || node.getAttribute("data-id") !== selectedTileId) active.blur();
  }, [selectedTileId]);
  // Focus mode: fitView to one node (`.`) / fit all (Esc). Reuses same nonce
  // pattern as focusReq so re-firing the same id still triggers.
  const [focusModeReq, setFocusModeReq] = useState<{ id: string | null; n: number } | null>(null);
  const focusModeNonceRef = useRef(0);

  // Open a file as a tab in the workbench's embedded editor (mounting the
  // workbench if it isn't open yet). The EditorTile picks the newly-appended
  // tab as active.
  // Open a file as a tab in a SPECIFIC editor tile (bound per-instance at node-
  // build time). The EditorTile picks the newly-appended tab as active.
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
  // Close an editor tile entirely (the WorkbenchTile's × ): drop the instance
  // and its tabs. (closeTile below handles the generic case; editor needs the
  // tab cleanup too.)
  const closeTile = useCallback((id: string) => {
    setTiles((ts) => ts.filter((t) => t.id !== id));
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

  // Manual tile selection. react-flow's built-in click-to-select is dead in our
  // config (selectionOnDrag + panOnDrag=[1,2] + per-node dragHandle → a node
  // click never applies selection — verified via probe). So we track the
  // selected tile ourselves via onNodeClick and inject `selected` + a high
  // zIndex into the node spec, which drives the highlight ring, the resize
  // handles (isVisible={selected}), and bring-to-front.
  // (selectedTileId state is declared higher up so openFile can use it.)

  // Frame nodes — Unreal-Blueprint-style colored comment boxes for grouping.
  // frames/frameOf each expose a synchronously-readable ref (updated in the
  // setter — see useStateWithRef). Async bind/unbind + the memoized keyboard
  // handler read the ref; render uses the state value.
  const [frames, setFrames, framesRef] = useStateWithRef<FrameState[]>(initial.frames);
  // Explicit tile→frame membership (see PersistedLayout.frameOf). Authoritative
  // for auto-fit, parenting, and the chip strip — geometry never decides it.
  const [frameOf, setFrameOf, frameOfRef] = useStateWithRef<Record<string, string>>(initial.frameOf ?? {});
  // The frame the user most recently touched (spawned into / dragged). The
  // collision-separation pass keeps THIS frame fixed and pushes neighbours, so
  // growing a frame never makes your focus jump.
  const lastActiveFrameRef = useRef<string | null>(null);
  const repoPathRef = useRef(repoPath);
  useEffect(() => { repoPathRef.current = repoPath; }, [repoPath]);
  const rootRef = useRef(root);
  useEffect(() => { rootRef.current = root; }, [root]);
  // pushToast is defined far below (depends on dismissToast). bind/unbind are
  // declared above it, so reach it through a ref populated by an effect.
  const pushToastRef = useRef<((t: { tileId: string; label: string; status: TileStatusKind }) => void) | null>(null);
  // Track the selected frame id so F2 / bring-to-front can target it without
  // needing to thread react-flow's selection state through every render.
  // ref (updated in the setter) so F2 / bring-to-front / the keyboard handler
  // read the latest selection without the listener effect rebinding.
  const [selectedFrameId, setSelectedFrameId, selectedFrameIdRef] = useStateWithRef<string | null>(null);

  // Reload layout when the repo changes — each repo has its own canvas state.
  // Skip on first mount (initial values already came from useMemo above).
  const lastRepoRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRepoRef.current === undefined) {
      lastRepoRef.current = repoPath;
      return;
    }
    if (lastRepoRef.current === repoPath) return;
    lastRepoRef.current = repoPath;
    const next = loadLayout(repoPath);
    setSizes(next.sizes);
    setPositions(next.positions);
    setFrames(next.frames);
    setTileNames(next.tileNames ?? {});
    setTiles(next.tiles ?? []);
    setEditorTabs(next.editorTabs ?? {});
    setFrameOf(next.frameOf ?? {});
    if (next.viewport) setViewport(next.viewport);
  }, [repoPath]);

  // Latest viewport mutated on every pan tick (cheap — ref, no re-render);
  // committed to state at onMoveEnd so the layout-persist effect picks it up
  // and writes it to localStorage. Reload restores via defaultViewport. Must
  // be declared BEFORE the persist useEffect below, whose deps array reads
  // `viewport` during render (TDZ if declared later).
  const currentViewportRef = useRef<{ x: number; y: number; zoom: number }>(
    initial.viewport ?? DEFAULT_VIEWPORT,
  );
  const [viewport, setViewport] = useState(initial.viewport ?? DEFAULT_VIEWPORT);

  // Persist on any layout change. **Trailing-debounced 250ms** so a drag
  // (which fires setPositions on every drop) doesn't trigger a synchronous
  // JSON.stringify of the full layout blob on the main thread per commit.
  // The serialize can be 50ms+ on a 20-tile workspace and the spike showed up
  // as a visible drop-snap stutter (P1 from perf review). Cancel on unmount
  // + on dep change so we don't keep stale references after repo switch.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined" || !repoPath) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      saveLayout(repoPath, { sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf });
    }, 250);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [repoPath, sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf]);
  // Flush on tab close / app quit so the debounced write doesn't lose the
  // last ~250ms of edits. `beforeunload` fires sync before localStorage is
  // torn down; we set the latest snapshot then.
  useEffect(() => {
    if (typeof window === "undefined" || !repoPath) return;
    const flush = () => {
      if (!persistTimerRef.current) return;
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = undefined;
      saveLayout(repoPath, { sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf });
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [repoPath, sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf]);

  // Viewport-focus request: we resolve the target's CENTER from our own state
  // (positions/sizes/frames) and hand absolute coords to <FocusOnTile>, which
  // setCenters on them. Resolving here (not via xyflow getNode) means focus
  // works even when the node hasn't been DOM-measured yet OR is culled
  // off-screen — fitView on an unmeasured node centers on a 0×0 box and does
  // nothing, which is why freshly-spawned tiles weren't centering.
  const [focusReq, setFocusReq] = useState<{ id: string; cx: number; cy: number; n: number } | null>(null);
  const focusTile = useCallback(
    (id: string) => {
      // Frame? center on its rect. Tile? center on pos + size.
      const frame = framesRef.current.find((f) => f.id === id);
      let cx: number, cy: number;
      if (frame) {
        cx = frame.x + frame.w / 2;
        cy = frame.y + frame.h / 2;
      } else {
        const p = positionsRef.current[id];
        if (!p) return;
        const s = sizesRef.current[id] ?? defaultTileSize(id);
        cx = p.x + s.width / 2;
        cy = p.y + s.height / 2;
      }
      setFocusReq((prev) => ({ id, cx, cy, n: (prev?.n ?? 0) + 1 }));
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

  /** Find the topmost frame containing the (x,y) point. Sorted by z desc so
   *  overlapping frames return the visually-topmost one. Used at tile-spawn
   *  time to auto-parent tiles dropped inside a frame. Returns the frame plus
   *  the position relative to the frame's origin (react-flow expects child
   *  positions to be relative when parentId set). */
  const sortedFrames = useMemo(
    () => [...frames].sort((a, b) => b.z - a.z),
    [frames],
  );
  // Membership by the tile's CENTER point (cx,cy), topmost frame wins. Center
  // (not top-left) makes "drag a tile out of the frame" intuitive — you drag
  // until its middle crosses the edge — and matches the auto-fit effect's rule.
  // Returns the owning frame's origin so the caller can compute the tile's
  // top-left RELATIVE position (relX = topLeftX − frame.x).
  const parentFrameOf = useCallback(
    (cx: number, cy: number): { parentId: string; fx: number; fy: number } | null => {
      // Innermost-frame-wins drop membership (pure — see frameAtPoint).
      const r = frameAtPoint(sortedFrames, cx, cy);
      return r ? { parentId: r.id, fx: r.x, fy: r.y } : null;
    },
    [sortedFrames],
  );

  // Which terminal tile ids fall inside each frame — drives the chip strip
  // in FrameNode header. Reuses the same absolute-position overlap logic as
  // parentFrameOf (positions[tileId] is ALWAYS absolute even when a tile is
  // react-flow-parented; we convert to relative only at the mkTile boundary).
  // Topmost frame wins (sortedFrames is z-desc) so overlapping frames don't
  // claim the same tile twice.
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

  // Display-name map for FrameNode chip strip: tile id → user/auto name.
  // Memoized to keep node memoization stable.
  // Agent title overlays the auto label; a user rename overlays both.
  const framesChipNames = useMemo(() => ({ ...agentTitles, ...tileNames }), [agentTitles, tileNames]);

  // ── Figma-style Layers panel data ─────────────────────────────────────────
  // Every open tile flattened to { id, kind, name, frameId } for the left rail.
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
      // Same effective-repo rule as node-build: a worktree/workspace frame can
      // supply the repo even when the canvas has no global one.
      const owner = fo[t.id] ? frames.find((f) => f.id === fo[t.id]) : undefined;
      const effRepo = owner?.worktreePath ?? owner?.workspacePath ?? repoPath ?? null;
      if ((t.kind === "editor" || t.kind === "diff") && !effRepo) continue;
      const kind: LayerTile["kind"] = t.kind === "shell" ? "terminal" : t.kind;
      const agent = t.kind === "claude" ? (agentForCmd(t.cmd)?.id ?? "claude") : undefined;
      out.push({ id: t.id, kind, name: tileNames[t.id] ?? agentTitles[t.id] ?? t.label, frameId: fo[t.id] ?? null, agent });
    }
    return out;
  }, [tiles, repoPath, frameOf, frames, tileNames, agentTitles]);
  const focusTileFromPanel = useCallback((id: string) => {
    setSelectedTileId(id);
    focusTile(id);
  }, [focusTile]);
  const focusFrameFromPanel = useCallback((id: string) => {
    setSelectedFrameId(id);
    setSelectedTileId(null);
    focusTile(id);
  }, [focusTile]);

  // Permission mode the next Claude spawn launches in. Verified flag values
  // (code.claude.com/docs cli-reference): default | acceptEdits | plan | auto |
  // dontAsk | bypassPermissions. Persisted so it survives restarts.
  const [claudeMode, setClaudeMode] = useState<string>(
    () => localStorage.getItem("hivemind:claude-mode") || "default",
  );
  useEffect(() => { localStorage.setItem("hivemind:claude-mode", claudeMode); }, [claudeMode]);
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
  const [spawnPick, setSpawnPick] = useState<{ kind: TileKind; mode?: string; work?: string; agent?: { id: string; cmd: string; args?: string[]; label: string } } | null>(null);
  // Text awaiting a claude target — set when something wants to deliver a prompt
  // ("Work on this", diff "send review") and 2+ claude tiles exist, so the user
  // picks WHICH claude (or a new one). 0 claude → spawn new directly; the picker
  // also lists the single-claude case as "this / new".
  const [claudePick, setClaudePick] = useState<{ text: string } | null>(null);
  // Frame awaiting a remote (ssh://) bind — set when FrameNode fires
  // `hivemind:attach-remote`; the modal connects, browses, and binds the picked
  // ssh uri as that frame's workspacePath.
  const [remoteAttach, setRemoteAttach] = useState<string | null>(null);
  useEffect(() => {
    const onAttach = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId: string }>).detail?.frameId;
      if (fid) setRemoteAttach(fid);
    };
    window.addEventListener("hivemind:attach-remote", onAttach as EventListener);
    return () => window.removeEventListener("hivemind:attach-remote", onAttach as EventListener);
  }, []);

  // Position a new tile inside a frame. Tiles pack left-to-right then WRAP to a
  // new row past FRAME_ROW_MAX (so a frame grows DOWN, not infinitely right).
  // The frame's SIZE is the auto-fit effect's job — it derives geometry from
  // the member bbox once this position commits, then separates frames so the
  // grown frame never overlaps a neighbour. We only pick the new tile's slot.
  // Tile spawning + in-frame placement (placeInFrame / ensureFrame / spawnTile
  // + spawnInto/spawnClaude/spawnVis/frameOpen). See useSpawn.
  const { spawnTile, spawnClaude, spawnAgent, spawnVis, spawnInto, frameOpen } = useSpawn({
    repoPath, claudeMode,
    positionsRef, sizesRef, tilesRef, frameOfRef, framesRef, selectedFrameIdRef,
    selectedTileIdRef, repoPathRef, rootRef, lastActiveFrameRef, claudeSeqRef,
    setFrameOf, setPositions, setSelectedTileId, setFocusReq, setFrames,
    setSelectedFrameId, setTiles, setSpawnPick, focusTile,
  });

  // Deliver a prompt to claude with a TARGET PICKER. "Work on this" and the
  // diff "send review" fire `hivemind:deliver-to-claude` with the text; we route
  // by how many claude tiles exist: 0 → spawn a new claude carrying the prompt;
  // 1+ → show a picker (the chosen tile, or "New claude"). Old direct paths
  // (spawn-claude / send-to-claude) still work for internal callers.
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

  // Spawn the island's CURRENTLY-selected agent (key "2"), reading agentSel via
  // a ref so the stable callback always uses the latest selection.
  const spawnSelectedAgent = useCallback(() => {
    const a = agentById(agentSelRef.current) ?? AGENTS[0]!;
    spawnAgent(a);
  }, [spawnAgent]);

  // Keyboard shortcuts + menu event listeners. See useCanvasShortcuts.
  useCanvasShortcuts({
    repoPath, spawnClaude, spawnSelectedAgent, spawnVis, spawnBrowser: () => spawnInto("browser"), addFrame, frameOpen, focusTile,
    setSelectedTileId, setFocusModeReq, selectedTileIdRef, selectedFrameIdRef,
    focusModeNonceRef, tilesRef,
  });

  // baseNodes: built WITHOUT selectedTileId. Heavy: rebuilds whenever any
  // layout / extras / frames / pile / size / position state changes. The
  // selection-derived `nodes` below shallow-clones only the selected and
  // previously-selected nodes — so a click-to-select doesn't trigger a full
  // rebuild + data-ref churn that would defeat React.memo on heavy wrappers.
  // Heavy node-array build (frames + tiles). Pure — see canvas-node-build.ts.
  // Rebuilds on any layout/frame/size/position change; the selection-derived
  // `nodes` memo below clones only the selected node so a click doesn't churn.
  const baseNodes: Node[] = useMemo(() => buildBaseNodes({
    repoPath, root, cwd, tiles, frames, frameOf, sizes, positions, editorTabs,
    tileNames, agentTitles, frameTiles, framesChipNames,
    updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, bringFrameToFront,
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace,
    openFileInTile, closeTabInTile, closeTile, onNodeResizeCommit, renameTile, setAgentTitle,
  }), [
    repoPath, root, cwd, tiles, editorTabs, frames, frameOf, sizes, positions,
    openFileInTile, closeTabInTile, closeTile, updateFrameTitle, updateFrameColor,
    deleteFrame, arrangeFrame, bringFrameToFront, onAttachWorktree, onCreateWorktree,
    unbindBranch, onNodeResizeCommit, frameTiles, tileNames, bindWorkspace,
    unbindWorkspace, renameTile, framesChipNames, agentTitles, setAgentTitle,
  ]);
  // Derive selection-aware nodes from baseNodes. Shallow-clones ONLY the
  // currently-selected and previously-selected tile so other nodes keep their
  // object identity → React.memo skips them. Frames keep their own z stacking.
  const nodes: Node[] = useMemo(() => {
    // No selection (the common case): baseNodes already carries every node's
    // zIndex (tiles 100 via mkTile, frames their own), so return it VERBATIM —
    // same array + node refs, zero allocation, no memo break.
    if (!selectedTileId) return baseNodes;
    // Selection: clone ONLY the selected node (zIndex 1000 + selected flag for
    // the ring + resize handles); every other node keeps its identity.
    return baseNodes.map((n) => {
      if (n.type === "frame" || n.id !== selectedTileId) return n;
      return { ...n, selected: true, style: { ...(n.style ?? {}), zIndex: 1000 } };
    });
  }, [baseNodes, selectedTileId]);
  const edges = EMPTY_EDGES;

  // MiniMap is opt-in — its `pannable zoomable` re-renders every node mini-rect
  // on every pan/zoom frame, a real cost with several live tiles. Off by default.
  const [minimapOn, setMinimapOn] = useState(false);
  const showMinimap = minimapOn && nodes.length > 0;
  const isEmpty = nodes.length === 0;

  // Motion-aware compositing: while the viewport pans/zooms we add a class that
  // (a) kills tile pointer-events (no hit-test churn) and (b) clips each tile's
  // paint via `contain` so the browser composites fewer/cheaper layers. Restored
  // shortly after motion stops. This is hivemind's take on Nyx's "GPU promotion
  // during motion". See styles.css `.canvas-moving`.
  const flowWrapRef = useRef<HTMLDivElement>(null);
  const moveEndTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Pan momentum: react-flow's pan stops DEAD on release, which reads as
  // "lifeless." Sample the viewport during a pan, and on release fling it with
  // velocity decay (like a slippy map). `inMomentumRef` guards our own
  // programmatic setViewport calls from re-feeding the sampler.
  const panSamplesRef = useRef<{ t: number; x: number; y: number }[]>([]);
  const inMomentumRef = useRef(false);
  const momentumNonce = useRef(0);
  const [momentumReq, setMomentumReq] = useState<{ vx: number; vy: number; n: number } | null>(null);
  // Bumped to snap the LIVE viewport crisp (ViewportSnap child applies it): on
  // pan/zoom settle, on fling settle, and on tile select — the moments a tile is
  // promoted to its own layer and a fractional transform would blur it.
  const [snapReq, setSnapReq] = useState(0);
  const bumpSnap = useCallback(() => setSnapReq((n) => n + 1), []);
  // Bumped to reset zoom to exactly 100% when a terminal is selected (xterm
  // selection/clicks are only pixel-accurate at zoom 1). Applied by SelectZoomReset.
  const [selZoomReq, setSelZoomReq] = useState(0);
  const onMove = useCallback((_: unknown, vp: { x: number; y: number; zoom: number }) => {
    currentViewportRef.current = vp;
    if (inMomentumRef.current) return; // ignore self-generated moves
    const s = panSamplesRef.current;
    s.push({ t: performance.now(), x: vp.x, y: vp.y });
    if (s.length > 6) s.shift();
  }, []);
  const onMoveStart = useCallback(() => {
    // Ignore move-starts emitted by our OWN momentum setViewport calls — only a
    // real user grab should re-add the motion class + cancel the fling.
    if (inMomentumRef.current) return;
    if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
    setMomentumReq(null); // cancel any in-flight fling when the user grabs again
    panSamplesRef.current = [];
    flowWrapRef.current?.classList.add("canvas-moving");
  }, []);
  const onMoveEnd = useCallback(() => {
    if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
    moveEndTimer.current = setTimeout(() => {
      flowWrapRef.current?.classList.remove("canvas-moving");
    }, 120);
    if (inMomentumRef.current) return;
    // Velocity (px/ms) from the last two recent samples; fling only on a real flick.
    const s = panSamplesRef.current;
    let flung = false;
    if (s.length >= 2) {
      const a = s[s.length - 2]!;
      const b = s[s.length - 1]!;
      const dt = b.t - a.t;
      if (dt > 0 && dt < 80) {
        const vx = (b.x - a.x) / dt;
        const vy = (b.y - a.y) / dt;
        if (Math.abs(vx) > 0.15 || Math.abs(vy) > 0.15) {
          setMomentumReq({ vx, vy, n: ++momentumNonce.current });
          flung = true;
        }
      }
    }
    panSamplesRef.current = [];
    // Commit the post-pan viewport to state so the layout-save effect persists
    // it. Triggers ONE re-render at the end of the pan (not per pointermove).
    // When the canvas comes to REST (no fling), snap it crisp: xterm rasterizes
    // its glyphs to a canvas that the react-flow viewport then CSS-transforms, so
    // a fractional translate or an off-by-epsilon zoom lands that bitmap on
    // sub-pixels → fuzzy text. Rounding the pan to the device-pixel grid and
    // snapping a near-1 zoom to exactly 1 makes text sharp whenever it's at rest
    // around 100%. (Other zoom levels still scale the bitmap — inherent.)
    const committed = flung ? currentViewportRef.current : snapViewportCrisp(currentViewportRef.current);
    currentViewportRef.current = committed;
    setViewport(committed);
    if (!flung) bumpSnap(); // snap the LIVE transform too (a fling snaps on settle)
  }, [bumpSnap]);
  // Dragging a TILE is a node drag (not a viewport move) so onMoveStart never
  // fires for it — that's why drag still felt laggy. Use a SEPARATE class with
  // compositing hints only (NOT pointer-events:none, which would drop the drag
  // gesture mid-move).
  const onNodeDragStart = useCallback(() => {
    flowWrapRef.current?.classList.add("canvas-dragging");
  }, []);
  // Remove SYNCHRONOUSLY on drop — must run BEFORE commitPosition's setPositions
  // flushes, so the `.react-flow__node` transition is active when xyflow re-syncs
  // the node's transform to the snapped target. Otherwise the snap lands instant
  // and the user never sees the "moment". (Tracked permanent fix: research lap on
  // tldraw + Framer Motion drop-land patterns.)
  const clearDragging = useCallback(() => {
    flowWrapRef.current?.classList.remove("canvas-dragging");
  }, []);
  // NodeResizer sets body.canvas-resizing on resize start; clear it when the
  // pointer is released (resize ends on pointerup, anywhere).
  useEffect(() => {
    const clear = () => document.body.classList.remove("canvas-resizing");
    document.addEventListener("pointerup", clear);
    return () => document.removeEventListener("pointerup", clear);
  }, []);

  // Compositor layer pre-promotion. MDN's "via script" pattern: set
  // `will-change: transform` on pointerdown, clear on pointerup. Pointerdown
  // beats xyflow's dragstart by ~50-150ms (human reaction + threshold check),
  // which is plenty of head-start for Blink to upload the layer. Only the
  // grabbed tile gets promoted — no layer explosion. CSS `:hover` would have
  // promoted every tile under the cursor and every frame the pointer crossed
  // (MDN: "Don't apply will-change to too many elements").
  // https://developer.mozilla.org/en-US/docs/Web/CSS/will-change#via_a_script
  // Layer pre-promotion via MDN "via_a_script" pattern. On pointerdown over a
  // heavy tile's drag handle, set `will-change: transform` so Blink uploads the
  // layer to the GPU BEFORE xyflow's drag-threshold trips. Cleared on
  // pointerup/cancel. Only ONE element promoted at a time — no layer explosion.
  // Frames are excluded (huge surface, would defeat the optimization).
  // https://developer.mozilla.org/en-US/docs/Web/CSS/will-change#via_a_script
  // Compositor layer pre-promotion via MDN "via_a_script" pattern. On
  // pointerdown over a heavy tile's drag handle, set `will-change: transform`
  // so Blink uploads the layer to the GPU BEFORE xyflow's drag-threshold trips.
  // Cleared on pointerup/cancel. Only ONE element promoted at a time — no
  // layer explosion. Frames excluded (huge surface).
  // https://developer.mozilla.org/en-US/docs/Web/CSS/will-change#via_a_script
  useEffect(() => {
    const wrap = flowWrapRef.current;
    if (!wrap) return;
    let promoted: HTMLElement | null = null;
    const onDown = (e: PointerEvent) => {
      const handle = (e.target as HTMLElement | null)?.closest(".tile-drag-handle");
      if (!handle) return;
      const node = handle.closest(
        ".react-flow__node-terminal, .react-flow__node-diff, .react-flow__node-workbench, .react-flow__node-editor, .react-flow__node-issues",
      ) as HTMLElement | null;
      if (!node) return;
      promoted = node;
      node.style.willChange = "transform";
    };
    const onUp = () => {
      if (promoted) {
        promoted.style.willChange = "";
        promoted = null;
      }
    };
    wrap.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      wrap.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // ── auto-pan to newly-spawned tiles ───────────────────────────────────────
  // (focusReq / focusTile are declared earlier so addFrame can pan to a new
  // frame.) When a tile is added we fly the viewport to it.
  // New claude/extra terminals: focus the most-recently-added one. Initialised
  // from the restored length so reopening the app doesn't pan to old tiles.
  // Only pan when OTHER tiles already exist (nodes.length > 1 after the add) —
  // the new tile is then appended off to the side and would otherwise land
  // off-screen. The first tile on an empty canvas is already framed by the
  // default viewport, so panning to it is both pointless and jarring.
  const prevExtrasLen = useRef(tiles.length);
  useEffect(() => {
    if (tiles.length > prevExtrasLen.current) {
      const last = tiles[tiles.length - 1];
      // Pan to the newly-spawned tile. FALLBACK ONLY: framed spawns are already
      // selected+focused by placeInFrame (the single authority); fire here only
      // for a LOOSE tile (no frameOf entry) so we don't double-animate.
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

  const handleNodeDragStop = useNodeDragStop({
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, clearDragging,
  });
  return (
    <div className="relative h-full w-full flex flex-col">
      {/* Suppress the native context menu inside the canvas so RIGHT-mouse drag
          pans (panOnDrag=[1,2]) instead of popping a menu that aborts the drag. */}
      <div ref={flowWrapRef} className="relative flex-1 min-h-0" onContextMenu={(e) => e.preventDefault()}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={initial.viewport ?? DEFAULT_VIEWPORT}
          minZoom={0.25}
          maxZoom={2.5}
          panOnScroll
          // Excalidraw/Figma model: hold Space to pan with left-drag; plain
          // left-drag does rubber-band selection.
          panActivationKeyCode="Space"
          selectionOnDrag
          panOnDrag={PAN_ON_DRAG}
          zoomOnPinch
          // Both default to 0 → a 1px pointer wobble during a click is read as a
          // drag and the click is swallowed (feels unresponsive). A few px of
          // slack makes clicks land reliably + a tiny jitter doesn't micro-drag.
          paneClickDistance={4}
          nodeClickDistance={4}
          deleteKeyCode={null}
          onMove={onMove}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onNodeDragStart={onNodeDragStart}
          // Tiles are HUGE (1200×820 by default) — bigger than typical window.
          // xyflow's default autoPanOnNodeDrag pans the viewport when the
          // DRAGGED NODE's edges approach the viewport edges. With a tile
          // already extending past the window edges, ANY drag triggers
          // continuous auto-pan → tile's screen position barely changes while
          // its internal canvas position moves correctly. Disable so drag is
          // a pure node move; user can pan separately via Space+drag.
          autoPanOnNodeDrag={false}
          // Manual selection (react-flow's click-select is dead in our config).
          // Clicking a tile selects it → highlight + handles + front. Clicking a
          // frame or the empty pane clears tile selection.
          onNodeClick={(_e, node) => {
            if (node.type === "frame") {
              setSelectedTileId(null);
            } else {
              // Re-frame only when selecting a DIFFERENT tile — re-clicking the
              // already-selected tile (e.g. to type) must NOT yank the viewport.
              const isNewSelection = !selectedTileIdsRef.current.has(node.id);
              setSelectedTileId(node.id);
              selectedTileIdsRef.current = new Set([node.id]);
              markSeen([node.id]);
              // Selecting promotes the tile to its own compositing layer; snap
              // the viewport so that layer lands on whole pixels (sharp, not
              // blurry). See ViewportSnap.
              bumpSnap();
              if (isNewSelection) {
                if (node.type === "terminal") {
                  // Terminals render via WebGL with a DPR supersample, so they
                  // stay crisp at ANY zoom — fit the whole tile in view instead
                  // of yanking to 100% (which, from an overview, made the tile
                  // "explode" to huge). fit-to-tile (maxZoom 1) frames the full
                  // transcript without zooming past native size.
                  focusTile(node.id);
                } else if (node.type === "diff" || node.type === "editor" || node.type === "workbench") {
                  // Diff (Pierre) + editor (CodeMirror) render DOM TEXT, which the
                  // browser only rasterizes crisply at 1:1. Snap to exactly 100%
                  // so a focused diff/editor is sharp (DOM can't supersample like
                  // the WebGL terminal).
                  setSelZoomReq((n) => n + 1);
                }
              }
            }
          }}
          onPaneClick={() => {
            setSelectedTileId(null);
            selectedTileIdsRef.current = new Set();
          }}
          onSelectionChange={({ nodes: sel }) => {
            // Track which frame (if any) is the user's current single
            // selection. Drives F2-rename + future bulk frame ops. We only
            // care about single-frame selection; multi-select clears.
            if (sel.length === 1 && sel[0]!.type === "frame") {
              setSelectedFrameId(sel[0]!.id);
            } else {
              setSelectedFrameId(null);
            }
            // Track selected tiles for agent-awareness: selecting a tile counts
            // as "seeing" it, so a done-unseen tile clears + its toast dismisses.
            const tileIds = sel.filter((n) => n.type !== "frame").map((n) => n.id);
            selectedTileIdsRef.current = new Set(tileIds);
            markSeen(tileIds);
          }}
          onNodeDragStop={handleNodeDragStop}
          // NEVER cull off-viewport tiles. Our tiles wrap LIVE PTY sessions
          // (claude/shell): react-flow unmounts a culled node, which tears the
          // tile's PTY down — detach+reattach (banner + full xterm/WebGL rebuild
          // + replay, reads as "the session restarted") in daemon mode, or an
          // outright kill+respawn (a genuinely NEW claude session) in the
          // in-process/non-persistent path. Spawning a new tile recenters the
          // viewport onto it, which pushed existing claude tiles off-screen →
          // they got culled → existing sessions were disturbed/recreated. So we
          // keep every node mounted; xterm's WebGL addon already falls back to
          // the DOM renderer if the GPU context cap is hit on huge boards.
          onlyRenderVisibleElements={false}
          // Perf: skip focus rings + ARIA per tile (we manage focus inside
          // tiles ourselves via xterm/Pierre).
          nodesFocusable={false}
          edgesFocusable={false}
          proOptions={PRO_OPTIONS}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="rgba(155,161,173,0.10)" />
          <FocusOnTile req={focusReq} />
          <FocusMode req={focusModeReq} />
          <PanMomentum req={momentumReq} activeRef={inMomentumRef} onSettle={bumpSnap} />
          <ViewportSnap req={snapReq} activeRef={inMomentumRef} />
          <SelectZoomReset req={selZoomReq} />

          {/* Excalidraw-style floating tool island — top-center. */}
          <Panel position="top-center" className="!m-0 !mt-3">
            <ToolIsland
              repoPath={repoPath}
              onToggle={(k) => spawnVis(k)}
              agentSel={agentSel}
              onAgentChange={setAgentSel}
              onSpawnAgent={(a) => spawnAgent(a)}
              onFrame={addFrame}
              onBrowser={() => spawnInto("browser")}
            />
          </Panel>

          {/* Roster removed — the top-left WorkspaceSwitcher (App) is the
              single workspace UI. Click a frame on the canvas to set active. */}

          {/* Live agent sessions now live in the Figma-style LayersPanel
              (bottom-left rail). The old top-left SessionChips strip was
              redundant with it and has been removed. */}

          {/* Background-event toasts — BOTTOM-right. (Was top-right, where it
              collided with + hid behind the Board/List/Canvas view switcher.)
              Bottom-right is clear: tool island is top-center, chips top-left,
              zoom bottom-left. An agent that goes blocked or finishes while
              off-screen pings here; click to fly to it. */}
          {toasts.length > 0 && (
            <Panel position="bottom-right" className="!m-0 !mr-3 !mb-3">
              <Toasts toasts={toasts} onDismiss={dismissToast} onView={(id) => markSeen([id])} />
            </Panel>
          )}

          {/* Zoom + nav island — bottom-left (Excalidraw footer). */}
          <Panel position="bottom-left" className="!m-0 !ml-3 !mb-3">
            <ZoomIsland
              tileCount={nodes.length}
              minimapOn={minimapOn}
              onToggleMinimap={() => setMinimapOn((v) => !v)}
              onReset={() => { setSizes({}); setPositions({}); setFrames([]); setTiles([]); setEditorTabs({}); setFrameOf({}); }}
              onFocus={() => {
                const id = selectedTileIdRef.current ?? selectedFrameIdRef.current;
                setFocusModeReq({ id, n: ++focusModeNonceRef.current });
              }}
            />
          </Panel>

          {showMinimap && (
            <MiniMap
              pannable
              zoomable
              className="!bg-[var(--color-bg3)] !border !border-[var(--color-line2)] !rounded-lg"
              maskColor="rgba(0,0,0,0.55)"
              nodeColor="var(--color-line2)"
            />
          )}

          {spawnPick && (
            <Panel position="top-center" className="!m-0 !mt-16">
              <div className="hm-island rounded-xl p-1.5 min-w-[240px] pointer-events-auto">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">
                  Spawn claude in
                </div>
                {/* Order each repo frame followed by its worktree children, so
                    the picker reads as a tree (children indented + tagged). */}
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
                        onClick={() => { spawnTile(spawnPick.kind, f.id, { mode: spawnPick.mode, work: spawnPick.work, agent: spawnPick.agent }); setSpawnPick(null); }}
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
            </Panel>
          )}
        </ReactFlow>
        {/* Figma-style layers rail — overlay (outside ReactFlow), only when
            there's something to list. */}
        {layerTiles.length > 0 && (
          <LayersPanel
            frames={layerFrames}
            tiles={layerTiles}
            selectedTileId={selectedTileId}
            onFocusTile={focusTileFromPanel}
            onFocusFrame={focusFrameFromPanel}
          />
        )}
        {isEmpty && (
          <CanvasEmptyState
            repoPath={repoPath}
            onShowTree={() => spawnVis("tree")}
            onShowShell={() => spawnVis("shell")}
            onShowDiff={() => spawnVis("diff")}
            onSpawnClaude={() => spawnClaude()}
            onInitWorkspace={onInitWorkspace}
          />
        )}
        <RemoteConnectModal
          open={remoteAttach !== null}
          onClose={() => setRemoteAttach(null)}
          onPick={(uri) => { if (remoteAttach) bindRemote(remoteAttach, uri); setRemoteAttach(null); }}
        />
        {claudePick && (
          <div className="fixed inset-0 z-50 grid place-items-center" onClick={() => setClaudePick(null)}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative w-[340px] max-w-[90vw] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] shadow-2xl p-1.5" onClick={(e) => e.stopPropagation()}>
              <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">
                Send to claude
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Excalidraw-style floating tool island — rounded panel of icon buttons,
 *  each with a single-key hotkey hint. Active tools highlight in brand color. */
// ToolIsland / ZoomIsland / FpsMeter / IslandBtn moved to canvas-islands.tsx

// ChipMeta + statusViz moved to canvas-overlays.tsx

// camera (FocusMode/FocusOnTile/PanMomentum/SelectZoomReset/ViewportSnap/useTileFocus) moved to canvas-camera.tsx

// Toasts + CanvasEmptyState moved to canvas-overlays.tsx
