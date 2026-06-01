import { memo, useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  NodeResizer,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import { TerminalTile } from "./TerminalTile";
// Lazy-loaded: the diff tile pulls in @pierre/diffs + its WASM/cpp syntax
// engine (~2.7MB), and the workbench pulls in CodeMirror. Code-split so a
// terminal-only session never pays to load them — they fetch on first open.
const DiffTile = lazy(() => import("./DiffTile").then((m) => ({ default: m.DiffTile })));
const WorkbenchTile = lazy(() => import("./WorkbenchTile").then((m) => ({ default: m.WorkbenchTile })));
import { FrameNode, type FrameNodeData } from "./FrameNode";
import { LayersPanel, type LayerTile, type LayerFrame } from "./LayersPanel";
import { IssuesTile } from "./IssuesTile";
import { Sparkles } from "lucide-react";
import { subscribeStatus, type TileStatusKind } from "./agent-status-bus";
import { identifyAgent } from "./agent-state";
import { resolveFrameCollisions, nextSlotInFrame, FRAME_ROW_MAX } from "./frame-layout";

/** Auto-derive a short tile name from the command. Uses identifyAgent for
 *  known agents (claude, codex, gemini, …), falls back to the basename of
 *  the cmd. User double-click rename still wins via tileNames map. */
function autoNameFromCmd(cmd: string): string {
  const agent = identifyAgent(cmd);
  if (agent) return agent;
  return cmd.split("/").pop()?.split(/\s+/)[0] ?? "terminal";
}

type TerminalNodeData = {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  label?: string;
  onClose?: () => void;
};

type DiffNodeData = {
  repoPath: string;
  initialMode?: "working" | "branch";
  initialBase?: string;
  onClose?: () => void;
};

type WorkbenchNodeData = {
  repoPath: string;
  tabs: string[];
  onOpenFile: (path: string) => void;
  onCloseTab: (path: string) => void;
  onClose: () => void;
};

// Each node wrapper is memoized so a Canvas re-render does NOT re-render
// every tile when its `data` is shallow-equal. Each is also wrapped in
// NodeResizer so the user can drag corners to resize. Wrappers use
// `w-full h-full` so the tile fills whatever size the node has — initial
// size comes from `style: {width, height}` on the node spec.
// Why zIndex + pointerEvents on handles + lines:
// xterm-helper-textarea (and Pierre's diff body) cover the full node area
// with active pointer-events. Without an explicit z-index + pointer-events
// override, NodeResizer's tiny 8×8 corner handles sit BELOW the tile content
// in stack order — pointerdown hits xterm instead of the handle, so corner
// drag never fires the resize gesture. Confirmed by xyflow GH #2156 and the
// "Cannot interact with the node content" thread (#2385) — same root pattern.
const RESIZER_PROPS = {
  // Floor raised from 240x140 — below this a terminal/diff clips its content
  // and slides under neighbors.
  minWidth: 340,
  minHeight: 200,
  color: "var(--color-brand)",
  // Resize is the heaviest motion (tile content reflows every frame). Flag the
  // body so styles.css can strip box-shadow/blur during the drag (xyflow #4711:
  // node CSS is recalculated every frame). Cleared by a global pointerup in Canvas.
  onResizeStart: () => document.body.classList.add("canvas-resizing"),
  handleStyle: {
    width: 12,
    height: 12,
    borderRadius: 3,
    zIndex: 20,
    pointerEvents: "all" as const,
    border: "2px solid var(--color-bg)",
  },
  lineStyle: {
    zIndex: 19,
    pointerEvents: "all" as const,
  },
} as const;

// IMPORTANT: NodeResizer reads its target node id from NodeIdContext via
// useNodeId(). When the context resolution returns undefined (we hit this
// in v12.10 — memo wrapping a custom node component subtly drops the
// context for the resizer's internal ResizeControl, so XYResizer's
// nodeLookup.get(undefined) returns no node and the drag-start handler
// returns early with zero visible effect), the resize gesture silently
// no-ops. Pass `nodeId={id}` explicitly so the store lookup always succeeds.
// Resize is committed via data.onResize so the parent Canvas state stays the
// source of truth for node size (style.width/height in the node spec).
// Without this, XYResizer updates react-flow's internal store, but our
// useMemo rebuilds nodes with the old style and the change disappears.
type WithResize<T> = T & { onResize: (id: string, w: number, h: number, x?: number, y?: number) => void };

// Single wheel authority for a tile, via a NATIVE non-passive CAPTURE listener
// (React's synthetic wheel handlers are passive — preventDefault is a no-op —
// and xterm/diff/editor consume the wheel with their own listeners before any
// canvas logic runs). Capture + non-passive lets us decide first:
//   • Ctrl/⌘ + wheel        → zoom the canvas toward the cursor (always).
//   • UNSELECTED tile       → PAN the canvas (and block the tile content from
//                             scrolling) — so trackpad/wheel moves the board
//                             even with the cursor over a tile.
//   • SELECTED tile         → let the content scroll (xterm scrollback / diff /
//                             editor); just stop the canvas from also panning.
// Click a tile to select it → it captures the wheel; click empty canvas to
// deselect → the wheel pans the board again.
function useTileWheelZoom(selected: boolean): React.RefObject<HTMLDivElement | null> {
  const { getViewport, setViewport, screenToFlowPosition } = useReactFlow();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const { x, y, zoom } = getViewport();
        const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.min(2.5, Math.max(0.25, zoom * factor));
        setViewport({ x: x + f.x * (zoom - next), y: y + f.y * (zoom - next), zoom: next });
        return;
      }
      if (selected) {
        // Let the tile content scroll; just stop react-flow from panning too.
        e.stopPropagation();
        return;
      }
      // Unselected → pan the canvas, block the content's own scroll.
      e.preventDefault();
      e.stopPropagation();
      const { x, y, zoom } = getViewport();
      setViewport({ x: x - e.deltaX, y: y - e.deltaY, zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // Middle/right-mouse drag pans the canvas EVEN over a tile. react-flow's
    // pane-pan only fires on the pane itself — a tile (a node) captures the
    // pointer, so panOnDrag=[1,2] does nothing once the cursor is over a tile.
    // Drive the pan ourselves when the tile is unselected (a selected tile keeps
    // middle/right for its own use, e.g. terminal middle-click paste).
    let panning = false;
    let lastX = 0, lastY = 0;
    const onMove = (ev: PointerEvent) => {
      if (!panning) return;
      const { x, y, zoom } = getViewport();
      setViewport({ x: x + (ev.clientX - lastX), y: y + (ev.clientY - lastY), zoom });
      lastX = ev.clientX; lastY = ev.clientY;
    };
    const endPan = (ev: PointerEvent) => {
      if (!panning) return;
      panning = false;
      try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    };
    const onDown = (ev: PointerEvent) => {
      if (selected) return;                 // selected tile handles its own input
      if (ev.button !== 1 && ev.button !== 2) return; // middle / right only
      ev.preventDefault();
      ev.stopPropagation();
      panning = true;
      lastX = ev.clientX; lastY = ev.clientY;
      try { el.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    };
    el.addEventListener("pointerdown", onDown, { capture: true });
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", endPan);
    el.addEventListener("pointercancel", endPan);

    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      el.removeEventListener("pointerdown", onDown, { capture: true });
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", endPan);
      el.removeEventListener("pointercancel", endPan);
    };
  }, [selected, getViewport, setViewport, screenToFlowPosition]);
  return ref;
}

// Fallback shown while a lazy-loaded heavy tile (diff/editor) fetches its chunk.
function TileLoading({ label }: { label: string }) {
  return (
    <div className="w-full h-full grid place-items-center rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] text-[12px] text-[var(--color-fg3)]">
      {label}
    </div>
  );
}

const TerminalNode = memo(function TerminalNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: WithResize<TerminalNodeData>;
  selected: boolean;
}) {
  const wheelRef = useTileWheelZoom(selected);
  return (
    <div className={`w-full h-full${selected ? " hm-node-selected" : " tile-locked"}`} ref={wheelRef}>
      <NodeResizer
        nodeId={id}
        isVisible={selected}
        {...RESIZER_PROPS}
        onResizeEnd={(_e, p) => data.onResize(id, p.width, p.height, p.x, p.y)}
      />
      <TerminalTile {...data} selected={selected} />
    </div>
  );
});

const DiffNode = memo(function DiffNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: WithResize<DiffNodeData>;
  selected: boolean;
}) {
  const wheelRef = useTileWheelZoom(selected);
  return (
    <div className={`w-full h-full${selected ? " hm-node-selected" : " tile-locked"}`} ref={wheelRef}>
      <NodeResizer
        nodeId={id}
        isVisible={selected}
        {...RESIZER_PROPS}
        minWidth={400}
        minHeight={240}
        onResizeEnd={(_e, p) => data.onResize(id, p.width, p.height, p.x, p.y)}
      />
      <Suspense fallback={<TileLoading label="Loading diff…" />}>
        <DiffTile {...data} />
      </Suspense>
    </div>
  );
});

const WorkbenchNode = memo(function WorkbenchNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: WithResize<WorkbenchNodeData>;
  selected: boolean;
}) {
  const wheelRef = useTileWheelZoom(selected);
  return (
    <div className={`w-full h-full${selected ? " hm-node-selected" : " tile-locked"}`} ref={wheelRef}>
      <NodeResizer
        nodeId={id}
        isVisible={selected}
        {...RESIZER_PROPS}
        minWidth={520}
        minHeight={360}
        onResizeEnd={(_e, p) => data.onResize(id, p.width, p.height, p.x, p.y)}
      />
      <Suspense fallback={<TileLoading label="Loading editor…" />}>
        <WorkbenchTile
          repoPath={data.repoPath}
          tabs={data.tabs}
          onOpenFile={data.onOpenFile}
          onCloseTab={data.onCloseTab}
          onClose={data.onClose}
        />
      </Suspense>
    </div>
  );
});

type IssuesNodeData = { root: string | null; onClose: () => void };
const IssuesNode = memo(function IssuesNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: WithResize<IssuesNodeData>;
  selected: boolean;
}) {
  const wheelRef = useTileWheelZoom(selected);
  return (
    <div className={`w-full h-full${selected ? " hm-node-selected" : " tile-locked"}`} ref={wheelRef}>
      <NodeResizer
        nodeId={id}
        isVisible={selected}
        {...RESIZER_PROPS}
        minWidth={280}
        onResizeEnd={(_e, p) => data.onResize(id, p.width, p.height, p.x, p.y)}
      />
      <IssuesTile root={data.root} onClose={data.onClose} />
    </div>
  );
});

const FrameNodeWrapper = memo(function FrameNodeWrapper({
  id,
  data,
  selected,
}: {
  id: string;
  data: FrameNodeData;
  selected: boolean;
}) {
  return <FrameNode id={id} data={data} selected={!!selected} />;
});

const nodeTypes: NodeTypes = {
  terminal: TerminalNode as unknown as NodeTypes[string],
  diff: DiffNode as unknown as NodeTypes[string],
  workbench: WorkbenchNode as unknown as NodeTypes[string],
  issues: IssuesNode as unknown as NodeTypes[string],
  frame: FrameNodeWrapper as unknown as NodeTypes[string],
};

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

/** Linux only. `-i` keeps the shell interactive so it doesn't exit, `-l`
 *  sources the login profile (PATH includes ~/.local/bin → claude resolves). */
function defaultShell(): { cmd: string; args: string[] } {
  return { cmd: "/bin/bash", args: ["-il"] };
}

// Every tile on the canvas is an INSTANCE now (was: claude/shell instanced via
// `extras`, but editor/diff/issues were global singletons keyed off a fixed id
// + a `vis` boolean). Unifying them means each workspace frame can hold its own
// editor/diff/issues, and terminals are instances everywhere. claude + shell
// are unlimited per frame; editor/diff/issues are one-per-frame (spawn focuses
// the existing one if that frame already has it).
type TileKind = "claude" | "shell" | "editor" | "diff" | "issues";
interface TileInstance {
  id: string;
  kind: TileKind;
  label: string;
  /** claude / shell only. */
  cmd?: string;
  args?: string[];
}
/** Kinds that are one-per-frame (spawn → focus existing). claude/shell are not. */
const SINGLETON_KINDS: ReadonlySet<TileKind> = new Set(["editor", "diff", "issues"]);

// Legacy persisted shapes (pre-unification) — migrated to TileInstance[] on load.
type LegacyVisibility = { tree: boolean; shell: boolean; diff: boolean; issues: boolean };
interface LegacyExtraTerm { id: string; label: string; cmd: string; args: string[]; }

// Persisted layout — survives app restarts. Keyed by repoPath (or a sentinel
// for the no-repo case) so each project's canvas comes back the way the user
// left it. Stored as a single JSON blob per repo to avoid N localStorage keys.
interface PersistedLayout {
  sizes: Record<string, { width: number; height: number }>;
  positions: Record<string, { x: number; y: number }>;
  frames: FrameState[];
  /** User-renamed tile labels (per tile id). */
  tileNames?: Record<string, string>;
  // Open tiles — so a restart resumes exactly where you left off (the PTY is
  // gone, but the tile + a fresh shell/claude respawn in place).
  tiles?: TileInstance[];
  /** Repo-relative paths open as tabs, keyed by editor tile id. */
  editorTabs?: Record<string, string[]>;
  // ── legacy (pre tile-unification) — read for migration, never written. ──
  vis?: LegacyVisibility;
  extras?: LegacyExtraTerm[];
  legacyEditorTabs?: string[];
  /** EXPLICIT tile→frame membership. Authoritative — frame geometry is derived
   *  from this, NOT the reverse. Set when a tile is spawned into or dropped
   *  inside a frame; cleared when dropped outside all frames. Decoupling
   *  membership from geometry avoids the bootstrap deadlock where a big tile
   *  whose center sits outside a collapsed frame never gets claimed. */
  frameOf?: Record<string, string>;
  /** Last viewport position so reopen drops user back where they were instead
   *  of resetting to (16, 24, zoom=1). Empty canvas + tiles persisted at high
   *  content coords used to read as "blank" — viewport reset stranded them
   *  off-screen with no obvious recovery. */
  viewport?: { x: number; y: number; zoom: number };
}
interface FrameState {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: string;
  z: number;
  /** Bound git branch — tiles inside this frame run isolated on it. */
  branch?: string;
  /** Worktree dir for `branch`; tiles inside use it as their cwd. */
  worktreePath?: string;
  /** Workspace zone: an arbitrary repo folder. Tiles inside run in this repo
   *  (cwd/repoPath) — lets multiple projects live on one canvas. */
  workspacePath?: string;
  /** The `.hivemind` root for `workspacePath` (for Issues/diff/tree scope). */
  workspaceRoot?: string | null;
}
/** Single workbench tile id — there is only ever one workbench (explorer +
 *  tabbed editor, attached) on the canvas. */
const WORKBENCH_TILE_ID = "tile-workbench-1";

/** Fallback tile dimensions for tiles never explicitly resized (so they have
 *  no entry in the `sizes` map). Mirrors the defaults in the nodes useMemo.
 *  Used by the frame auto-fit effect to estimate a child's box without a DOM
 *  measurement. */
function defaultTileSize(id: string): { width: number; height: number } {
  if (id === WORKBENCH_TILE_ID || id === "tile-diff-1") return { width: 1400, height: 900 };
  if (id === "tile-issues-1") return { width: 680, height: 460 };
  // terminals + claude extras
  return { width: 1200, height: 820 };
}

/** Default size by KIND — the single source of truth for a fresh tile's box.
 *  Node-building, the frame auto-fit effect, and placeInFrame all derive from
 *  this so the frame grows to the tile's ACTUAL rendered size. (defaultTileSize
 *  above keyed off fixed ids, which broke once tiles became per-instance with
 *  timestamped ids — claude rendered 1480×1000 but the frame fit it to 1200×820
 *  and the tile spilled out.) */
function defaultSizeForKind(kind: TileKind): { width: number; height: number } {
  switch (kind) {
    case "editor":
    case "diff":
      return { width: 1400, height: 900 };
    case "issues":
      return { width: 680, height: 460 };
    case "claude":
      return { width: 1480, height: 1000 };
    case "shell":
    default:
      return { width: 1200, height: 820 };
  }
}

// Frame auto-fit geometry. Frames are sized to the bbox of their member tiles
// + these paddings; an empty frame collapses to the placeholder so a bound
// workspace zone stays a visible, droppable target with its header chrome.
const FRAME_PAD = 28;
const FRAME_HEADER = 36;
const FRAME_EMPTY_W = 460;
const FRAME_EMPTY_H = 200;
const LAYOUT_KEY = (repoPath: string | null) => `hivemind:canvas-layout:${repoPath ?? "__global__"}`;
// One-time cleanup: an earlier version persisted the no-repo case under
// `__global__`, which leaked test/welcome layouts across unrelated sessions.
// We never persist there anymore — wipe any stale value on startup so old
// installs don't carry forward phantom frames.
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("hivemind:canvas-layout:__global__");
  } catch { /* private mode etc — ignore */ }
}
function loadLayout(repoPath: string | null): PersistedLayout {
  if (typeof window === "undefined") return { sizes: {}, positions: {}, frames: [] };
  // Only persist when we have a real repo — the no-repo case is transient
  // (welcome screen / e2e bootstrap) and persisting it leaks layouts across
  // unrelated sessions.
  if (!repoPath) return { sizes: {}, positions: {}, frames: [], tileNames: {} };
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY(repoPath));
    if (!raw) return { sizes: {}, positions: {}, frames: [], tileNames: {} };
    const p = JSON.parse(raw) as Partial<PersistedLayout>;
    // Backfill `z` for frames persisted before z existed.
    const frames = Array.isArray(p.frames)
      ? p.frames.map((f, i) => ({ ...f, z: typeof f.z === "number" ? f.z : i })) as FrameState[]
      : [];
    const positions = p.positions ?? {};
    const sizes = p.sizes ?? {};
    // Migration: layouts saved before explicit `frameOf` existed have no
    // membership map. Seed it ONCE from geometry (tile center inside the
    // topmost frame) — a one-time snapshot, not a runtime feedback loop. After
    // this, membership is tracked explicitly on drop/spawn.
    let frameOf = p.frameOf;
    if (!frameOf && frames.length > 0) {
      frameOf = {};
      const sorted = [...frames].sort((a, b) => b.z - a.z);
      for (const [tid, pos] of Object.entries(positions)) {
        const s = sizes[tid] ?? { width: 700, height: 480 };
        const cx = pos.x + s.width / 2;
        const cy = pos.y + s.height / 2;
        const owner = sorted.find((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h);
        if (owner) frameOf[tid] = owner.id;
      }
    }
    // Tiles: new format persists a `tiles` array. Old layouts persisted
    // `vis` (singleton editor/diff/issues) + `extras` (instanced claude/shell)
    // + a single `editorTabs` array — migrate them to instances, REUSING the
    // canonical fixed ids so the saved sizes/positions/frameOf keep resolving.
    let tiles: TileInstance[];
    let editorTabs: Record<string, string[]>;
    if (Array.isArray(p.tiles)) {
      tiles = p.tiles;
      editorTabs = (p.editorTabs && typeof p.editorTabs === "object" && !Array.isArray(p.editorTabs))
        ? (p.editorTabs as Record<string, string[]>)
        : {};
    } else {
      tiles = [];
      editorTabs = {};
      for (const e of Array.isArray(p.extras) ? p.extras : []) {
        const kind: TileKind = identifyAgent(e.cmd) === "claude" ? "claude" : "shell";
        tiles.push({ id: e.id, kind, label: e.label, cmd: e.cmd, args: e.args });
      }
      const v = p.vis;
      if (v?.tree) {
        tiles.push({ id: WORKBENCH_TILE_ID, kind: "editor", label: "Editor" });
        const legacyTabs = Array.isArray(p.editorTabs)
          ? (p.editorTabs as unknown as string[])
          : Array.isArray((p as { fileTiles?: { file: string }[] }).fileTiles)
            ? (p as { fileTiles: { file: string }[] }).fileTiles.map((f) => f.file)
            : [];
        if (legacyTabs.length) editorTabs[WORKBENCH_TILE_ID] = legacyTabs;
      }
      if (v?.shell) {
        const sh = defaultShell();
        tiles.push({ id: "tile-terminal-1", kind: "shell", label: "shell", cmd: sh.cmd, args: sh.args });
      }
      if (v?.diff) tiles.push({ id: "tile-diff-1", kind: "diff", label: "Diff" });
      if (v?.issues) tiles.push({ id: "tile-issues-1", kind: "issues", label: "Issues" });
    }
    return {
      sizes,
      positions,
      frames,
      frameOf,
      tileNames: p.tileNames ?? {},
      tiles,
      editorTabs,
      viewport: p.viewport && typeof p.viewport.x === "number" && typeof p.viewport.y === "number"
        ? { x: p.viewport.x, y: p.viewport.y, zoom: Number(p.viewport.zoom) || 1 }
        : undefined,
    };
  } catch {
    return { sizes: {}, positions: {}, frames: [], tileNames: {} };
  }
}

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
  const [tiles, setTiles] = useState<TileInstance[]>(initial.tiles ?? []);
  const tilesRef = useRef(tiles);
  useEffect(() => { tilesRef.current = tiles; }, [tiles]);
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
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>(initial.sizes);
  // User-renamed tile labels (per tile id). Persisted with layout.
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
  const sizesRef = useRef(sizes);
  useEffect(() => { sizesRef.current = sizes; }, [sizes]);
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
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(initial.positions);
  const positionsRef = useRef(positions);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
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
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const selectedTileIdRef = useRef<string | null>(null);
  useEffect(() => { selectedTileIdRef.current = selectedTileId; }, [selectedTileId]);
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
  }, []);

  // Manual tile selection. react-flow's built-in click-to-select is dead in our
  // config (selectionOnDrag + panOnDrag=[1,2] + per-node dragHandle → a node
  // click never applies selection — verified via probe). So we track the
  // selected tile ourselves via onNodeClick and inject `selected` + a high
  // zIndex into the node spec, which drives the highlight ring, the resize
  // handles (isVisible={selected}), and bring-to-front.
  // (selectedTileId state is declared higher up so openFile can use it.)

  // Frame nodes — Unreal-Blueprint-style colored comment boxes for grouping.
  const [frames, setFrames] = useState<FrameState[]>(initial.frames);
  // Mirror frames to a ref so async bind/unbind handlers read the latest list
  // without re-creating the callback on every frame change.
  const framesRef = useRef<FrameState[]>(frames);
  // Explicit tile→frame membership (see PersistedLayout.frameOf). Authoritative
  // for auto-fit, parenting, and the chip strip — geometry never decides it.
  const [frameOf, setFrameOf] = useState<Record<string, string>>(initial.frameOf ?? {});
  const frameOfRef = useRef(frameOf);
  useEffect(() => { frameOfRef.current = frameOf; }, [frameOf]);
  useEffect(() => { framesRef.current = frames; }, [frames]);
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
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  // Mirror to a ref so the (memoized) keyboard handler can read the latest
  // selection without forcing the listener effect to rebind on every change.
  const selectedFrameIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedFrameIdRef.current = selectedFrameId;
  }, [selectedFrameId]);

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
      try {
        window.localStorage.setItem(
          LAYOUT_KEY(repoPath),
          JSON.stringify({ sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf }),
        );
      } catch {
        // QuotaExceeded / private-mode etc — swallow; layout is best-effort.
      }
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
      try {
        window.localStorage.setItem(
          LAYOUT_KEY(repoPath),
          JSON.stringify({ sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf }),
        );
      } catch { /* swallow */ }
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

  const addFrame = useCallback(() => {
    const id = `frame-${Date.now()}`;
    setFrames((fs) => {
      const n = fs.length + 1;
      const maxZ = fs.reduce((m, f) => (f.z > m ? f.z : m), 0);
      // Big enough to hold a tile (workbench/diff are 720-760px wide) — a
      // 520x360 frame let dropped tiles sprawl past its edges and occlude each
      // other, so the zone looked empty.
      const w = 840;
      const h = 580;
      // Place each new frame to the RIGHT of all existing frames (not stacked
      // at a fixed point — that piled them on top of each other). Auto-pan
      // below then flies the viewport to it, so it's always visible.
      const rightEdge = fs.reduce((m, f) => Math.max(m, f.x + f.w), 0);
      const x = fs.length ? rightEdge + 48 : 120;
      const y = 120;
      return [
        ...fs,
        { id, x, y, w, h, title: `Group ${n}`, color: "var(--color-brand)", z: maxZ + 1 },
      ];
    });
    // Pan to the new frame — otherwise it spawns off-screen and is invisible
    // (the #1 frame complaint). rAF lets the node mount before we center on it.
    requestAnimationFrame(() => focusTile(id));
  }, [focusTile]);
  const updateFrameTitle = useCallback((id: string, title: string) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, title } : f)));
  }, []);
  const updateFrameColor = useCallback((id: string, color: string) => {
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, color } : f)));
  }, []);
  const deleteFrame = useCallback((id: string) => {
    setFrames((fs) => fs.filter((f) => f.id !== id));
  }, []);
  // ── reactive frame auto-fit ───────────────────────────────────────────────
  // Frame geometry is DERIVED from its member tiles, not stored-and-grown.
  // Whenever tile positions / sizes / visibility / extras change (all of which
  // fire at human-action frequency — drag-STOP, resize-commit, spawn, toggle —
  // never per-animation-frame) we recompute every frame to the bbox of the
  // tiles whose CENTER falls inside it, + padding. Empty frames collapse to a
  // small labeled placeholder so a workspace zone stays a visible drop target.
  //
  // Membership is EXPLICIT (frameOf), not derived from geometry — that avoids
  // the bootstrap deadlock where a big tile whose center sits outside a
  // collapsed frame would never be claimed, so the frame could never grow to
  // it. `frames` is NOT a dependency (updater reads `prev`) → never self-fires.
  useEffect(() => {
    // Tiles that actually exist right now (closed tiles' stale frameOf ignored).
    // editor/diff need a repo — they're not rendered without one.
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

    // 1) DESIRED geometry: each frame fits its members' bbox (empty → collapse
    //    to a placeholder at its current origin).
    const cur = framesRef.current;
    const desired = cur.map((f) => {
      const mem = memberRects.get(f.id);
      if (!mem || mem.length === 0) {
        return { id: f.id, x: f.x, y: f.y, w: FRAME_EMPTY_W, h: FRAME_EMPTY_H };
      }
      const minX = Math.min(...mem.map((m) => m.x));
      const minY = Math.min(...mem.map((m) => m.y));
      const maxR = Math.max(...mem.map((m) => m.r));
      const maxB = Math.max(...mem.map((m) => m.b));
      return {
        id: f.id,
        x: Math.round(minX - FRAME_PAD),
        y: Math.round(minY - FRAME_HEADER),
        w: Math.round(maxR - minX + FRAME_PAD * 2),
        h: Math.round(maxB - minY + FRAME_HEADER + FRAME_PAD),
      };
    });

    // 2) SEPARATE: nudge frames so none overlap, keeping the last-touched frame
    //    fixed. Apply each frame's delta to its MEMBER TILES (absolute coords)
    //    so the next derive lands the frame at the separated spot — and to empty
    //    frames' origins directly (they have no members to carry them).
    const deltas = resolveFrameCollisions(desired, lastActiveFrameRef.current);
    const tileShifts: Record<string, { dx: number; dy: number }> = {};
    const finalById = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const d of desired) {
      const del = deltas[d.id] ?? { dx: 0, dy: 0 };
      finalById.set(d.id, { x: d.x + del.dx, y: d.y + del.dy, w: d.w, h: d.h });
      if ((del.dx !== 0 || del.dy !== 0) && (memberIds.get(d.id)?.length ?? 0) > 0) {
        for (const tid of memberIds.get(d.id)!) tileShifts[tid] = del;
      }
    }

    // Commit frame geometry (2px dead-band → no churn / no self-fire loop).
    setFrames((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const fin = finalById.get(f.id);
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

    // Commit member-tile shifts (drives the NEXT derive to the separated spot;
    // converges because once separated the resolver returns zero deltas).
    const shiftIds = Object.keys(tileShifts);
    if (shiftIds.length) {
      setPositions((p) => {
        let changed = false;
        const np = { ...p };
        for (const id of shiftIds) {
          const c = p[id];
          const s = tileShifts[id]!;
          if (!c || (Math.abs(s.dx) < 1 && Math.abs(s.dy) < 1)) continue;
          np[id] = { x: c.x + s.dx, y: c.y + s.dy };
          changed = true;
        }
        return changed ? np : p;
      });
    }
  }, [positions, sizes, tiles, repoPath, frameOf]);
  // Drag synced on stop (not per-tick) — react-flow renders the live drag
  // internally via transform, we just persist the final x/y to our source-
  // of-truth state so the next render rebuilds the node at the right place.
  const moveFrame = useCallback((id: string, x: number, y: number) => {
    // The dragged frame is the anchor — neighbours yield to where you drop it.
    lastActiveFrameRef.current = id;
    setFrames((fs) => fs.map((f) => (f.id === id ? { ...f, x, y } : f)));
  }, []);
  // Bring a frame above all other frames. Useful when two frames overlap
  // and the one you want is buried. We bump its z to max+1 (no full
  // renumber — the integers grow but that's harmless until 2^53).
  const bringFrameToFront = useCallback((id: string) => {
    setFrames((fs) => {
      const maxZ = fs.reduce((m, f) => (f.z > m ? f.z : m), 0);
      const target = fs.find((f) => f.id === id);
      if (!target || target.z === maxZ) return fs;
      return fs.map((f) => (f.id === id ? { ...f, z: maxZ + 1 } : f));
    });
  }, []);

  // ── worktree binding ──────────────────────────────────────────────────────
  // Bind a frame to a git branch: create (or reuse) a worktree under the repo,
  // then stash {branch, worktreePath} on the FrameState. Tiles spawned inside
  // the frame then run with cwd = worktreePath (see mkTile below). Errors are
  // surfaced via a toast — never crash the canvas.
  const bindBranch = useCallback(async (frameId: string, rawBranch: string) => {
    const branch = rawBranch.trim();
    if (!branch || !repoPath) return;
    try {
      const res = await window.hive.worktreeCreate(repoPath, { branch });
      setFrames((fs) =>
        fs.map((f) => (f.id === frameId ? { ...f, branch: res.branch, worktreePath: res.path } : f)),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[hivemind] worktree bind failed:", msg);
      pushToastRef.current?.({
        tileId: `frame-bind-${frameId}`,
        label: `bind ${branch} failed: ${msg.slice(0, 120)}`,
        status: "blocked",
      });
    }
  }, [repoPath]);

  const unbindBranch = useCallback(async (frameId: string) => {
    const frame = framesRef.current.find((f) => f.id === frameId);
    if (!frame?.worktreePath || !repoPath) {
      // Nothing on disk to remove — just clear the fields.
      setFrames((fs) => fs.map((f) => (f.id === frameId ? { ...f, branch: undefined, worktreePath: undefined } : f)));
      return;
    }
    // Removing a worktree is destructive (drops uncommitted work in it).
    const ok = typeof window.confirm === "function"
      ? window.confirm(`Remove worktree for branch "${frame.branch}"?\n\n${frame.worktreePath}\n\nUncommitted changes there will be lost.`)
      : true;
    if (!ok) return;
    try {
      await window.hive.worktreeRemove(repoPath, frame.worktreePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[hivemind] worktree remove failed:", msg);
      pushToastRef.current?.({
        tileId: `frame-unbind-${frameId}`,
        label: `unbind failed: ${msg.slice(0, 120)}`,
        status: "blocked",
      });
      return;
    }
    setFrames((fs) => fs.map((f) => (f.id === frameId ? { ...f, branch: undefined, worktreePath: undefined } : f)));
  }, [repoPath]);

  // ── workspace-zone binding ────────────────────────────────────────────────
  // Bind a frame to an arbitrary repo folder so multiple projects coexist on
  // one canvas. Tiles inside the frame then run with cwd/repoPath = that repo
  // and root = its .hivemind (see mkTile). Reuses the folder picker + project
  // resolver; installs the agentic stack so the zone's agents can work issues.
  const bindWorkspace = useCallback(async (frameId: string) => {
    try {
      const dir = await window.hive.pickProjectFolder();
      if (!dir) return;
      const proj = await window.hive.resolveProject(dir);
      const wsPath = proj.repoPath ?? dir;
      const name = wsPath.split("/").filter(Boolean).pop() ?? "workspace";
      setFrames((fs) =>
        fs.map((f) =>
          f.id === frameId
            ? { ...f, workspacePath: wsPath, workspaceRoot: proj.root ?? null, title: name }
            : f,
        ),
      );
      // Best-effort: make the zone's repo work-on-this capable. Don't block/await.
      void window.hive.installAgentic(wsPath).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[hivemind] bind workspace failed:", msg);
      pushToastRef.current?.({
        tileId: `frame-ws-${frameId}`,
        label: `bind workspace failed: ${msg.slice(0, 120)}`,
        status: "blocked",
      });
    }
  }, []);

  const unbindWorkspace = useCallback((frameId: string) => {
    // External repo — nothing on disk to remove; just clear the binding.
    setFrames((fs) =>
      fs.map((f) => (f.id === frameId ? { ...f, workspacePath: undefined, workspaceRoot: undefined } : f)),
    );
  }, []);

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
      for (const f of sortedFrames) {
        if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) {
          return { parentId: f.id, fx: f.x, fy: f.y };
        }
      }
      return null;
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
  const framesChipNames = useMemo(() => ({ ...tileNames }), [tileNames]);

  // Which tile kinds currently have ≥1 instance — drives the ToolIsland active
  // highlight (the buttons now SPAWN rather than toggle, so "active" just means
  // "you have one of these open somewhere").
  const presentKinds = useMemo(() => new Set<TileKind>(tiles.map((t) => t.kind)), [tiles]);

  // ── Figma-style Layers panel data ─────────────────────────────────────────
  // Every open tile flattened to { id, kind, name, frameId } for the left rail.
  const layerFrames: LayerFrame[] = useMemo(
    () => frames.map((f) => ({ id: f.id, title: f.title, color: f.color })),
    [frames],
  );
  const layerTiles: LayerTile[] = useMemo(() => {
    const out: LayerTile[] = [];
    const fo = frameOf;
    for (const t of tiles) {
      if ((t.kind === "editor" || t.kind === "diff") && !repoPath) continue;
      const kind: LayerTile["kind"] = t.kind === "shell" ? "terminal" : t.kind;
      out.push({ id: t.id, kind, name: tileNames[t.id] ?? t.label, frameId: fo[t.id] ?? null });
    }
    return out;
  }, [tiles, repoPath, frameOf, tileNames]);
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

  // Monotonic session counter — `xs.length + 1` produced DUPLICATE labels
  // (#3, #3) after kill+respawn. This only ever increases.
  const claudeSeqRef = useRef(0);
  // Spawn-target picker: when 2+ workspaces (base + workspace-zone frames) live
  // on the canvas, ask WHERE a new claude should run instead of guessing.
  const [spawnPick, setSpawnPick] = useState<{ kind: TileKind; mode?: string } | null>(null);

  // Position a new tile inside a frame. Tiles pack left-to-right then WRAP to a
  // new row past FRAME_ROW_MAX (so a frame grows DOWN, not infinitely right).
  // The frame's SIZE is the auto-fit effect's job — it derives geometry from
  // the member bbox once this position commits, then separates frames so the
  // grown frame never overlaps a neighbour. We only pick the new tile's slot.
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

    // Existing members of THIS frame (explicit frameOf), to pack beside.
    const members: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    for (const t of tilesRef.current) {
      if (t.id === id) continue;
      if (frameOfRef.current[t.id] !== frame.id) continue;
      const p = pos[t.id];
      if (!p) continue;
      const s = sizeOf(t.id);
      members.push({ id: t.id, x: p.x, y: p.y, w: s.width, h: s.height });
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

  // frame = workspace: EVERY tile lives in a frame, never loose on the canvas.
  // Returns the frame to open into — the active one, else the first existing,
  // else lazily creates a "base" workspace frame bound to the launch repo (so
  // the empty playground gets a real workspace the moment you open anything).
  const ensureFrame = useCallback((): FrameState => {
    const sel = selectedFrameIdRef.current;
    const selF = sel ? framesRef.current.find((f) => f.id === sel) : undefined;
    if (selF) return selF;
    // Prefer a workspace-bound frame over an empty base — without this, a
    // user-bound zone (e.g. "manageark") that wasn't created first would lose
    // spawns to a stale base frame, and tiles would land off-screen relative
    // to the visible workspace.
    const bound = framesRef.current.find((f) => f.workspacePath || f.worktreePath);
    if (bound) return bound;
    const first = framesRef.current[0];
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
      color: "var(--color-brand)", z: 0,
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

  // Single-source spawn path for new claude/shell/extra terminals. ALWAYS
  // standalone — auto-pile-on-spawn was removed (user wanted a per-tile title
  // via double-click rename, not stacking). Manual pile is still available
  // via the clip-to-pile button on the tile header. Caller passes a
  // `targetFrameId` to land the new tile inside a frame's grid (placeInFrame
  // cascades into free slots + auto-grows the frame).
  // Create a tile of `kind` inside `targetFrameId` (or the resolved active
  // frame). claude/shell are unlimited per frame; editor/diff/issues are
  // one-per-frame — if the frame already has one, focus it instead of making a
  // duplicate. placeInFrame lays it out + auto-grows the frame + selects/foci.
  const spawnTile = useCallback(
    (kind: TileKind, targetFrameId: string | null, opts?: { mode?: string }): void => {
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
      if (kind === "claude") {
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
      // claude/shell get a sequenced display name so two open claudes read as
      // "claude #1" / "claude #2"; user-rename via the pencil overrides it.
      if (cmd) setTileNames((map) => (map[newId] ? map : { ...map, [newId]: `${autoNameFromCmd(cmd!)} #${n}` }));
    },
    [claudeMode, placeInFrame, ensureFrame, focusTile],
  );

  // Spawn from a global surface (ToolIsland / palette / hotkey). With 2+
  // workspaces, ALWAYS ask which one (the picker pre-highlights the selected
  // frame but requires an explicit pick) — never silently spawn into a stale
  // selection. Single frame (or none) → spawn into it / lazily create base.
  const spawnInto = useCallback((kind: TileKind, opts?: { mode?: string }) => {
    if (framesRef.current.length >= 2) {
      setSpawnPick({ kind, mode: opts?.mode });
      return;
    }
    spawnTile(kind, ensureFrame().id, opts);
  }, [spawnTile, ensureFrame]);

  // Back-compat thin wrappers for the many existing call sites.
  const spawnClaude = useCallback((mode?: string) => spawnInto("claude", { mode }), [spawnInto]);
  const spawnVis = useCallback(
    (which: "tree" | "shell" | "diff" | "issues") =>
      spawnInto(which === "tree" ? "editor" : which),
    [spawnInto],
  );

  // Open a tile INSIDE a specific frame (the frame's launcher toolbar) — always
  // targets that frame, no picker. Same one-per-frame rule via spawnTile.
  const frameOpen = useCallback((frameId: string, kind: string) => {
    const k: TileKind =
      kind === "tree" ? "editor"
      : kind === "claude" || kind === "shell" || kind === "diff" || kind === "issues" ? kind
      : "shell";
    spawnTile(k, frameId);
  }, [spawnTile]);

  // Wire palette events + keyboard shortcuts. CommandPalette dispatches events
  // (decoupled from Canvas state); plus ⌘\ → spawn claude, ⌘B/T/D → toggle.
  useEffect(() => {
    const onSpawn = (e: Event) => {
      const d = (e as CustomEvent).detail;
      spawnClaude(d && typeof d === "object" ? d.mode : undefined);
    };
    const onToggle = (e: Event) => {
      const which = (e as CustomEvent<"tree" | "shell" | "diff" | "issues">).detail;
      if (which === "tree" || which === "shell" || which === "diff" || which === "issues") {
        spawnVis(which);
      }
    };
    const inEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      // ── modifier shortcuts (kept for muscle memory) ──
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "\\") { e.preventDefault(); spawnClaude(); }
        else if ((e.key === "b" || e.key === "B") && repoPath) { e.preventDefault(); spawnVis("tree"); }
        else if (e.key === "t" || e.key === "T") { e.preventDefault(); spawnVis("shell"); }
        else if ((e.key === "d" || e.key === "D") && repoPath) { e.preventDefault(); spawnVis("diff"); }
        return;
      }
      // Focus mode hotkeys fire even when typing in a tile (xterm/CodeMirror
      // are "editable" so the typing-guard below blocks them) — they navigate
      // the canvas, not the focused content.
      if (e.key === ".") {
        const id = selectedTileIdRef.current ?? selectedFrameIdRef.current;
        if (id) { e.preventDefault(); setFocusModeReq({ id, n: ++focusModeNonceRef.current }); }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFocusModeReq({ id: null, n: ++focusModeNonceRef.current });
        return;
      }
      // ── single-key tool hotkeys (number row only) — when NOT typing ──
      // NOTE: bare LETTER aliases (a/t/b/d/f/c) were removed — in a dev tool you
      // type letters constantly, and a stray `a` on the canvas spawned a whole
      // claude session. Numbers match the ToolIsland hint badges 1-6; letter
      // combos still work behind Cmd/Ctrl (handled above).
      if (inEditable(e.target)) return;
      switch (e.key) {
        case "1":
          e.preventDefault(); spawnVis("shell"); break;
        case "2":
          e.preventDefault(); spawnClaude(); break;
        case "3":
          if (repoPath) { e.preventDefault(); spawnVis("tree"); } break;
        case "4":
          if (repoPath) { e.preventDefault(); spawnVis("diff"); } break;
        case "5":
          if (repoPath) { e.preventDefault(); spawnVis("issues"); } break;
        case "6":
          e.preventDefault(); addFrame(); break;
        case "F2": {
          const sel = selectedFrameIdRef.current;
          if (!sel) return;
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("hivemind:frame-rename", { detail: sel }));
          break;
        }
        default: break;
      }
    };
    const onAddFrame = () => addFrame();
    const onFrameOpen = (e: Event) => {
      const d = (e as CustomEvent<{ frameId: string; kind: string }>).detail;
      if (d?.frameId && d?.kind) frameOpen(d.frameId, d.kind);
    };
    window.addEventListener("hivemind:spawn-claude", onSpawn);
    window.addEventListener("hivemind:canvas-toggle", onToggle as EventListener);
    window.addEventListener("hivemind:add-frame", onAddFrame);
    window.addEventListener("hivemind:frame-open", onFrameOpen as EventListener);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hivemind:spawn-claude", onSpawn);
      window.removeEventListener("hivemind:canvas-toggle", onToggle as EventListener);
      window.removeEventListener("hivemind:add-frame", onAddFrame);
      window.removeEventListener("hivemind:frame-open", onFrameOpen as EventListener);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  // baseNodes: built WITHOUT selectedTileId. Heavy: rebuilds whenever any
  // layout / extras / frames / pile / size / position state changes. The
  // selection-derived `nodes` below shallow-clones only the selected and
  // previously-selected nodes — so a click-to-select doesn't trigger a full
  // rebuild + data-ref churn that would defeat React.memo on heavy wrappers.
  const baseNodes: Node[] = useMemo(() => {
    const out: Node[] = [];
    let x = 40;
    const y = 60;
    const gap = 24;

    /** Build a node spec; parenting comes from the EXPLICIT frameOf map (not
     *  geometry), so a tile stays a child of its frame regardless of the
     *  frame's current auto-fitted size. NO extent:'parent' — tiles move
     *  freely; membership changes only on drop (onNodeDragStop). */
    const mkTile = (base: Omit<Node, "position">, ax: number, ay: number): Node => {
      // Override with user-dragged position if any.
      const p = positions[base.id];
      const px = p?.x ?? ax;
      const py = p?.y ?? ay;
      const parentFrame = frameOf[base.id] ? frames.find((f) => f.id === frameOf[base.id]) : undefined;
      if (parentFrame) {
        const owner = parentFrame;
        // Zone repo for tiles inside this frame: a worktree (branch zone) wins,
        // else a bound workspace folder (workspace zone), else nothing (the
        // tile keeps the canvas's base repoPath/cwd/root).
        const zoneRepo = owner?.worktreePath ?? owner?.workspacePath;
        // A workspace zone is a DIFFERENT repo bound to the frame. A worktree
        // zone is the SAME repo on another branch (its dir has no .hivemind of
        // its own — issues stay the project's, so it keeps the base root).
        const isWorkspaceZone = !owner?.worktreePath && owner?.workspacePath != null;
        const bd = base.data as Record<string, unknown>;
        const data = zoneRepo
          ? {
              ...bd,
              ...("cwd" in bd ? { cwd: zoneRepo } : {}),
              ...("repoPath" in bd ? { repoPath: zoneRepo } : {}),
              // Issues/diff/tree tiles scope by `root` (.hivemind). For a
              // workspace zone, point them at THAT repo's root — or null when it
              // has no workspace. CRITICAL: never fall through to the canvas
              // base root here; that leaked the launch repo's issues into an
              // unrelated frame (a frame bound to a repo with no .hivemind
              // showed the launch repo's board — the cross-repo leak bug).
              ...("root" in bd && isWorkspaceZone ? { root: owner?.workspaceRoot ?? null } : {}),
            }
          : base.data;
        return {
          ...base,
          data,
          position: { x: px - parentFrame.x, y: py - parentFrame.y },
          parentId: parentFrame.id,
        };
      }
      return { ...base, position: { x: px, y: py } };
    };

    // Apply user-resized dimensions over the initial spec, if any. Clamp
    // the default to the visible viewport: a 1400px-wide tile on a 1366px
    // laptop screen spawns wider than the window with no way to grab the
    // right resize handle without scrolling first.
    const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
    const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
    const sized = (id: string, w: number, h: number) => {
      const s = sizes[id];
      if (s) return { width: s.width, height: s.height };
      return { width: Math.min(w, Math.max(640, vw - 80)), height: Math.min(h, Math.max(420, vh - 120)) };
    };

    // Frames FIRST. React-flow requires parent nodes to appear before their
    // children in the nodes array — otherwise the `parentId` lookup runs
    // before the frame exists and you get the warning "Parent node X not
    // found" + the parentId is silently dropped (data-parent-id stays null
    // in the DOM, no real reparenting). Verified via playwright test.
    for (const f of frames) {
      // zIndex: frames live BELOW tiles (tiles get the default ~0). We use
      // Frames sit BEHIND tiles but ABOVE the canvas (dotted Background). The
      // old `-1000 + f.z` pushed them behind the Background too → invisible.
      // Range 0..(f.z) keeps frame-to-frame ordering (bringFrameToFront bumps
      // f.z) while staying under tiles, which get a baseline zIndex ≥ 10 below.
      out.push({
        id: f.id,
        type: "frame",
        position: { x: f.x, y: f.y },
        style: { width: f.w, height: f.h, zIndex: Math.min(f.z, 90) },
        data: {
          id: f.id,
          title: f.title,
          color: f.color,
          branch: f.branch,
          worktreePath: f.worktreePath,
          workspacePath: f.workspacePath,
          workspaceRoot: f.workspaceRoot,
          canBind: !!repoPath,
          onTitleChange: updateFrameTitle,
          onColorChange: updateFrameColor,
          onDelete: deleteFrame,
          onBringToFront: bringFrameToFront,
          onBindBranch: bindBranch,
          onUnbindBranch: unbindBranch,
          onBindWorkspace: bindWorkspace,
          onUnbindWorkspace: unbindWorkspace,
          tileIds: frameTiles.get(f.id) ?? [],
          // Merge pile names so pile ids resolve to their label in the chip
          // strip. Without this a pile chip would render as "terminal".
          tileNames: framesChipNames,
        },
        dragHandle: ".tile-drag-handle",
      });
    }

    // One loop, every tile is an instance. editor/diff/issues need a repo —
    // skip them (close them) if the active repo went away. Each kind maps to
    // its node `type` + default size + data shape.
    for (const t of tiles) {
      if ((t.kind === "editor" || t.kind === "diff") && !repoPath) continue;
      let node: Omit<Node, "position">;
      // Single source of truth for the default box — keep in lockstep with the
      // auto-fit effect (both use defaultSizeForKind) so the frame grows to the
      // tile's real size.
      const { width: w, height: h } = defaultSizeForKind(t.kind);
      if (t.kind === "editor") {
        node = {
          id: t.id,
          type: "workbench",
          style: sized(t.id, w, h),
          data: {
            repoPath,
            tabs: editorTabs[t.id] ?? [],
            onOpenFile: (file: string) => openFileInTile(t.id, file),
            onCloseTab: (file: string) => closeTabInTile(t.id, file),
            onClose: () => closeTile(t.id),
            onResize: onNodeResizeCommit,
          },
          dragHandle: ".tile-drag-handle",
        };
      } else if (t.kind === "diff") {
        node = {
          id: t.id,
          type: "diff",
          style: sized(t.id, w, h),
          data: {
            repoPath,
            initialMode: "working" as const,
            initialBase: "origin/main",
            onResize: onNodeResizeCommit,
            onClose: () => closeTile(t.id),
          },
          dragHandle: ".tile-drag-handle",
        };
      } else if (t.kind === "issues") {
        node = {
          id: t.id,
          type: "issues",
          style: sized(t.id, w, h),
          data: { root, onResize: onNodeResizeCommit, onClose: () => closeTile(t.id) },
          dragHandle: ".tile-drag-handle",
        };
      } else {
        // claude / shell — both render as a TerminalTile. Claude defaults
        // BIGGER (long transcripts + inline diffs); shell stays compact.
        const cmd = t.cmd ?? defaultShell().cmd;
        const args = t.args ?? defaultShell().args;
        node = {
          id: t.id,
          type: "terminal",
          style: sized(t.id, w, h),
          data: {
            tileId: t.id,
            cwd,
            cmd,
            args,
            label: t.label,
            name: tileNames[t.id] ?? autoNameFromCmd(cmd),
            onRename: renameTile,
            onResize: onNodeResizeCommit,
            onClose: () => closeTile(t.id),
          },
          dragHandle: ".tile-drag-handle",
        };
      }
      out.push(mkTile(node, x, y));
      x += (sizes[t.id]?.width ?? w) + gap;
    }
    return out;
    // Selection (selectedTileId) is applied in a SEPARATE useMemo below — it
    // shallow-clones only the affected tiles. Keeping it OUT of this dep list
    // means a click that just changes selection no longer rebuilds the entire
    // nodes array + reallocates every tile's `data` object — which was
    // defeating React.memo on heavy node wrappers mid-interaction (P1 from
    // perf review).
  }, [
    repoPath,
    root,
    cwd,
    tiles,
    editorTabs,
    frames,
    frameOf,
    sizes,
    positions,
    openFileInTile,
    closeTabInTile,
    closeTile,
    updateFrameTitle,
    updateFrameColor,
    deleteFrame,
    bringFrameToFront,
    bindBranch,
    unbindBranch,
    onNodeResizeCommit,
    frameTiles,
    tileNames,
    bindWorkspace,
    unbindWorkspace,
    renameTile,
    framesChipNames,
  ]);
  // Derive selection-aware nodes from baseNodes. Shallow-clones ONLY the
  // currently-selected and previously-selected tile so other nodes keep their
  // object identity → React.memo skips them. Frames keep their own z stacking.
  const nodes: Node[] = useMemo(() => {
    if (!selectedTileId) {
      // Most renders: no selection → reuse baseNodes verbatim (cheapest path).
      // Apply baseline zIndex if not set so xyflow layers tiles above frames.
      return baseNodes.map((n) => {
        if (n.type === "frame") return n;
        if (n.style?.zIndex != null) return n;
        return { ...n, style: { ...(n.style ?? {}), zIndex: 100 } };
      });
    }
    return baseNodes.map((n) => {
      if (n.type === "frame") return n;
      const sel = n.id === selectedTileId;
      // Selected: zIndex 1000 + selected flag → highlight ring + resize handles.
      // Non-selected: keep identity (avoid memo break) unless we need to set
      // a default zIndex.
      if (sel) {
        return { ...n, selected: true, style: { ...(n.style ?? {}), zIndex: 1000 } };
      }
      if (n.style?.zIndex != null) return n;
      return { ...n, style: { ...(n.style ?? {}), zIndex: 100 } };
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
    if (s.length >= 2) {
      const a = s[s.length - 2]!;
      const b = s[s.length - 1]!;
      const dt = b.t - a.t;
      if (dt > 0 && dt < 80) {
        const vx = (b.x - a.x) / dt;
        const vy = (b.y - a.y) / dt;
        if (Math.abs(vx) > 0.15 || Math.abs(vy) > 0.15) {
          setMomentumReq({ vx, vy, n: ++momentumNonce.current });
        }
      }
    }
    panSamplesRef.current = [];
    // Commit the post-pan viewport to state so the layout-save effect persists
    // it. Triggers ONE re-render at the end of the pan (not per pointermove).
    setViewport(currentViewportRef.current);
  }, []);
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

  // ── herdr-style agent awareness ───────────────────────────────────────────
  // Tiles publish their detected state to agent-status-bus; we mirror it here to
  // (a) color the live-session chips, (b) flag done-UNSEEN tiles (finished while
  // you weren't looking), and (c) toast when an OFF-SCREEN agent needs you.
  type TileMeta = { label: string; status: TileStatusKind; seen: boolean };
  const [statuses, setStatuses] = useState<Map<string, TileMeta>>(() => new Map());
  // Mirror of `statuses` so the bus listener can read the PREVIOUS status
  // synchronously (to detect working→idle "done" transitions) without putting
  // side effects inside a setState updater.
  const statusesRef = useRef<Map<string, TileMeta>>(statuses);
  // Which tiles the user currently has selected — drives toast suppression and
  // marks done tiles as "seen". Ref so the bus listener reads the latest set
  // without re-subscribing on every selection change.
  const selectedTileIdsRef = useRef<Set<string>>(new Set());

  interface Toast { id: string; tileId: string; label: string; status: TileStatusKind }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);
  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((ts) => {
      // Collapse a prior toast for the same tile — only the latest state matters.
      const kept = ts.filter((x) => x.tileId !== t.tileId);
      return [...kept, { ...t, id }];
    });
    // Blocked (needs you) lingers; a "done" notice is lower-stakes — auto-clear.
    const ttl = t.status === "blocked" || t.status === "permission" || t.status === "question" ? 12000 : 7000;
    setTimeout(() => dismissToast(id), ttl);
  }, [dismissToast]);

  // Expose pushToast to the (earlier-declared) bind/unbind worktree handlers.
  useEffect(() => { pushToastRef.current = pushToast; }, [pushToast]);

  const commitStatuses = useCallback((m: Map<string, TileMeta>) => {
    statusesRef.current = m;
    setStatuses(m);
  }, []);

  // Mark tiles as seen (clears done-unseen + dismisses their toasts).
  const markSeen = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const prev = statusesRef.current;
    let changed = false;
    const next = new Map(prev);
    for (const id of ids) {
      const m = next.get(id);
      if (m && !m.seen) { next.set(id, { ...m, seen: true }); changed = true; }
    }
    if (changed) commitStatuses(next);
    // Return the SAME array reference when nothing matches — otherwise every
    // selection-change emits a fresh [] and, because `nodes` is rebuilt each
    // render, react-flow re-fires onSelectionChange → infinite loop (React #185).
    setToasts((ts) => (ts.some((t) => ids.includes(t.tileId)) ? ts.filter((t) => !ids.includes(t.tileId)) : ts));
  }, [commitStatuses]);

  useEffect(() => {
    const off = subscribeStatus((e) => {
      const selected = selectedTileIdsRef.current.has(e.tileId);
      const prev = statusesRef.current;
      const old = prev.get(e.tileId);
      const finished = e.status === "idle" && old?.status === "working"; // done now
      const needsHuman =
        e.status === "blocked" || e.status === "permission" || e.status === "question";
      // "seen" = user is looking (tile selected) OR nothing noteworthy happened.
      const seen = selected ? true : finished || needsHuman ? false : old?.seen ?? true;
      const next = new Map(prev);
      next.set(e.tileId, { label: e.label, status: e.status, seen });
      commitStatuses(next);
      // Toast only for background events — suppress when the tile is selected
      // (you're already looking at it). herdr does the same tab-aware suppression.
      if (!selected && (needsHuman || finished)) {
        pushToast({ tileId: e.tileId, label: e.label, status: e.status });
      }
    });
    return off;
  }, [commitStatuses, pushToast]);

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
              setSelectedTileId(node.id);
              selectedTileIdsRef.current = new Set([node.id]);
              markSeen([node.id]);
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
          onNodeDragStop={(_e, node) => {
            clearDragging();
            // Persist final position. Frames update their own list.
            // Tiles: react-flow returns position RELATIVE to parentId
            // when parented, but our positions map stores ABSOLUTE so
            // mkTile's parentFrameOf can detect frame containment on
            // re-render. Convert via positionAbsolute when available.
            if (node.type === "frame") {
              // Dragging a frame carries its tiles. react-flow moves parented
              // children visually during the drag, but our positions map
              // (absolute) is stale on drop — translate every EXPLICIT member
              // (frameOf === this frame) by the frame's delta.
              const old = framesRef.current.find((f) => f.id === node.id);
              if (old) {
                const dx = node.position.x - old.x;
                const dy = node.position.y - old.y;
                if (dx !== 0 || dy !== 0) {
                  const moveIds = Object.keys(frameOfRef.current).filter(
                    (tid) => frameOfRef.current[tid] === node.id,
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
                }
              }
              moveFrame(node.id, node.position.x, node.position.y);
              return;
            }
            // xyflow v12.3.6 returns `positionAbsolute: undefined` for
            // parented nodes — only `node.position` (RELATIVE to parent) is
            // populated. The previous fallback `positionAbsolute ?? position`
            // stored the relative value as if it were absolute → each drag
            // shifted the tile by -frame.x on the next render (parentFrameOf
            // re-derived a relative inside frame, but the absolute had drifted).
            // Compute absolute manually from parent.
            const absRaw =
              (node as { positionAbsolute?: { x: number; y: number } }).positionAbsolute;
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
            commitPosition(node.id, ax, ay);
            // Update EXPLICIT membership from the drop location: the tile joins
            // whichever frame contains its CENTER (topmost), or becomes loose if
            // dropped outside every frame. This is the ONLY place geometry maps
            // to membership — a one-shot user action, not a feedback loop.
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
          }}
          // Cull off-viewport tiles ONLY past a threshold. xyflow's guidance:
          // culling helps with MANY nodes, but with few it adds expensive
          // mount/unmount churn on every pan — and our tiles are heavy (xterm +
          // WebGL context, Pierre diff). So keep all mounted for small canvases
          // (smooth pan, no teardown), and cull once there are enough tiles that
          // steady-state cost + WebGL-context pressure outweigh the churn.
          onlyRenderVisibleElements={nodes.length > 8}
          // Perf: skip focus rings + ARIA per tile (we manage focus inside
          // tiles ourselves via xterm/Pierre).
          nodesFocusable={false}
          edgesFocusable={false}
          proOptions={PRO_OPTIONS}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="rgba(155,161,173,0.10)" />
          <FocusOnTile req={focusReq} />
          <FocusMode req={focusModeReq} />
          <PanMomentum req={momentumReq} activeRef={inMomentumRef} />

          {/* Excalidraw-style floating tool island — top-center. */}
          <Panel position="top-center" className="!m-0 !mt-3">
            <ToolIsland
              present={presentKinds}
              repoPath={repoPath}
              onToggle={(k) => spawnVis(k)}
              onClaude={() => spawnClaude()}
              onFrame={addFrame}
              claudeMode={claudeMode}
              onClaudeModeChange={setClaudeMode}
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
                {frames.map((f) => {
                  const isSel = f.id === selectedFrameId;
                  return (
                    <button
                      key={f.id}
                      autoFocus={isSel}
                      onClick={() => { spawnTile(spawnPick.kind, f.id, { mode: spawnPick.mode }); setSpawnPick(null); }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-colors ${
                        isSel ? "bg-[var(--color-bg3)] ring-1 ring-[var(--color-brand)]" : ""
                      }`}
                    >
                      <span aria-hidden className="size-2 rounded-full" style={{ background: f.color }} />
                      <span className="truncate">{f.title}</span>
                      <span className="ml-auto text-[10px] text-[var(--color-fg3)]">
                        {isSel ? "selected" : "workspace"}
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
      </div>
    </div>
  );
}

/** Excalidraw-style floating tool island — rounded panel of icon buttons,
 *  each with a single-key hotkey hint. Active tools highlight in brand color. */
function ToolIsland({
  present,
  repoPath,
  onToggle,
  onClaude,
  onFrame,
  claudeMode,
  onClaudeModeChange,
}: {
  present: ReadonlySet<TileKind>;
  repoPath: string | null;
  onToggle: (k: "tree" | "shell" | "diff" | "issues") => void;
  onClaude: () => void;
  onFrame: () => void;
  claudeMode: string;
  onClaudeModeChange: (m: string) => void;
}) {
  return (
    <div className="hm-island flex items-center gap-0.5 p-1.5">
      <ToolButton label="Terminal" hint="1" active={present.has("shell")} onClick={() => onToggle("shell")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M4 6l2 2-2 2M8 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Claude" hint="2" accent active={present.has("claude")} onClick={onClaude}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>} />
      <select
        value={claudeMode}
        onChange={(e) => onClaudeModeChange(e.target.value)}
        title="Claude permission mode for new sessions"
        className="h-7 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md text-[10px] font-mono text-[var(--color-fg2)] px-1 outline-none cursor-pointer hover:text-[var(--color-fg)]"
      >
        <option value="default">default</option>
        <option value="plan">plan</option>
        <option value="acceptEdits">acceptEdits</option>
        <option value="auto">auto</option>
        <option value="dontAsk">dontAsk</option>
        <option value="bypassPermissions">bypass</option>
      </select>
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Explorer" hint="3" active={present.has("editor")} disabled={!repoPath} onClick={() => onToggle("tree")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.7 2.7 3 3.5 3h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Diff" hint="4" active={present.has("diff")} disabled={!repoPath} onClick={() => onToggle("diff")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 2v8m0 0a2 2 0 1 0 0 0Zm8-4v2m0 0a2 2 0 1 0 0 0Zm0 0v2a2 2 0 0 1-2 2H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Issues" hint="5" active={present.has("issues")} disabled={!repoPath} onClick={() => onToggle("issues")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="9" y="2.5" width="5" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/></svg>} />
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Frame" hint="6" onClick={onFrame}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M5 2v12M11 2v12M2 5h12M2 11h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>} />
    </div>
  );
}

function ToolButton({
  label,
  hint,
  icon,
  active,
  accent,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${label} — needs a repo` : `${label}  (${hint})`}
      className={`relative grid place-items-center size-9 rounded-lg transition-colors ${
        active
          ? accent
            ? "bg-[var(--color-brand)] text-white"
            : "bg-[var(--color-bg4)] text-[var(--color-fg)] ring-1 ring-[var(--color-brand)]"
          : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
      } ${disabled ? "opacity-30 cursor-not-allowed" : ""}`}
    >
      {icon}
      {/* Inherit text color (currentColor) so the hint stays legible on the
          active/accent fill — a fixed gray vanished on claude's blue bg. */}
      <kbd className="absolute bottom-0.5 right-1 font-mono text-[8px] leading-none opacity-60">{hint}</kbd>
    </button>
  );
}

/** Bottom-left zoom + nav island (Excalidraw footer). Uses react-flow's
 *  imperative camera API; lives inside <ReactFlow> so the hooks resolve. */
function ZoomIsland({ tileCount, onReset, minimapOn, onToggleMinimap, onFocus }: { tileCount: number; onReset: () => void; minimapOn: boolean; onToggleMinimap: () => void; onFocus: () => void }) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const pct = Math.round(zoom * 100);
  const [fpsOn, setFpsOn] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <div className="hm-island flex items-center overflow-hidden">
        <IslandBtn title="Zoom out (Ctrl -)" onClick={() => zoomOut({ duration: 150 })}>
          <svg width="13" height="13" viewBox="0 0 14 14"><path d="M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </IslandBtn>
        <button
          onClick={() => zoomTo(1, { duration: 150 })}
          title="Reset to 100% (Ctrl 1)"
          className="px-2 h-8 text-[11px] font-mono tabular-nums text-[var(--color-fg2)] hover:text-[var(--color-fg)] min-w-[3.2rem]"
        >{pct}%</button>
        <IslandBtn title="Zoom in (Ctrl +)" onClick={() => zoomIn({ duration: 150 })}>
          <svg width="13" height="13" viewBox="0 0 14 14"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </IslandBtn>
      </div>
      <div className="hm-island flex items-center overflow-hidden">
        <IslandBtn title="Fit to view (Ctrl 0)" onClick={() => fitView({ duration: 200, padding: 0.2 })}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </IslandBtn>
        <IslandBtn title="Focus selected (.)  ·  Esc to fit all" onClick={onFocus}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.3"/><path d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </IslandBtn>
        <IslandBtn title="Reset tile layout for this project" onClick={onReset}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11 1v3H8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </IslandBtn>
        <IslandBtn title={minimapOn ? "Hide minimap" : "Show minimap"} onClick={onToggleMinimap}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" opacity={minimapOn ? 1 : 0.5}><rect x="1.5" y="2.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><rect x="7.5" y="6.5" width="3.5" height="3" rx="0.6" fill="currentColor"/></svg>
        </IslandBtn>
        <IslandBtn title={fpsOn ? "Hide FPS meter" : "Show FPS meter (watch it while dragging)"} onClick={() => setFpsOn((v) => !v)}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" opacity={fpsOn ? 1 : 0.5}><path d="M2 10l3-4 2.5 2L12 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </IslandBtn>
      </div>
      {fpsOn && <FpsMeter />}
      <span className="ml-1 text-[10px] text-[var(--color-fg3)] font-mono tabular-nums select-none">
        {tileCount} {tileCount === 1 ? "tile" : "tiles"}
      </span>
    </div>
  );
}

/** Live FPS readout (rAF-sampled, updated 2×/s). Off by default — only mounts
 *  (and runs its rAF loop) when toggled on, so it never costs anything idle.
 *  Color: green ≥55 · amber 30-54 · red <30. Watch it dip while dragging a tile
 *  to measure jank empirically (the headless test harness can't). */
function FpsMeter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (t: number) => {
      frames++;
      if (t - last >= 500) {
        setFps(Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const color = fps >= 55 ? "var(--color-ok)" : fps >= 30 ? "var(--color-warn)" : "var(--color-err)";
  return (
    <span
      className="ml-1 text-[10px] font-mono tabular-nums select-none"
      style={{ color }}
      title="frames/sec — drag a tile and watch this; a big dip = jank to fix"
    >
      {fps} fps
    </span>
  );
}

function IslandBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="grid place-items-center size-8 text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] transition-colors"
    >{children}</button>
  );
}

// ── Agent awareness (ported concept from herdr) ─────────────────────────────
type ChipMeta = { label: string; status: TileStatusKind; seen: boolean };

/** Map a tile's status (+ done-unseen flag) to dot color / pulse / short label.
 *  herdr's 4-state model: working (amber) · needs-you (red) · done-unseen
 *  (blue) · idle-seen (green). exited = gray. */
function statusViz(m?: ChipMeta): { color: string; pulse: boolean; text: string } {
  if (!m) return { color: "var(--color-fg3)", pulse: false, text: "…" };
  switch (m.status) {
    case "working":
      // Working is steady amber, NOT pulsing — reserve motion for the
      // actionable "needs you" state only (pulsing everything is the slop tell).
      return { color: "var(--color-warn)", pulse: false, text: "working" };
    case "blocked":
    case "permission":
    case "question":
      return { color: "var(--color-err)", pulse: true, text: "needs you" };
    case "exited":
      return { color: "var(--color-fg3)", pulse: false, text: "exited" };
    case "idle":
    default:
      // "done" (finished while unseen) is informational, not actionable — it
      // gets a distinct sky accent + a ring (see SessionChips) but does NOT
      // pulse. Only "needs you" (actionable) pulses.
      return m.seen
        ? { color: "var(--color-ok)", pulse: false, text: "idle" }
        : { color: "var(--color-accent)", pulse: false, text: "done" };
  }
}

/** Pans the viewport to a requested tile once it has mounted + been measured.
 *  Polls a few rAF ticks because a freshly-spawned node isn't laid out on the
 *  same frame the request fires. Rendered inside <ReactFlow>. */
/** Focus mode: fitView to ONE node (req.id) or to ALL nodes (req.id === null).
 *  Hotkey `.` focuses the selected; Escape exits to fit-all. */
function FocusMode({ req }: { req: { id: string | null; n: number } | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!req) return;
    if (req.id) {
      // Near-fullscreen: tiny padding so the tile fills the window edge-to-edge
      // (neighbors no longer peek in), and maxZoom up to 1.6 so a small tile
      // enlarges to fill instead of sitting tiny + centered. Big tiles (claude)
      // land at zoom<1 and show whole, which is the maximized feel.
      void fitView({ nodes: [{ id: req.id }], padding: 0.03, duration: 400, maxZoom: 1.6 });
    } else {
      void fitView({ padding: 0.2, duration: 400 });
    }
  }, [req, fitView]);
  return null;
}

function FocusOnTile({ req }: { req: { id: string; cx: number; cy: number; n: number } | null }) {
  const { setCenter, getZoom, getNode, fitView } = useReactFlow();
  useEffect(() => {
    if (!req) return;
    // Two-stage focus, same end result as the "." focus-selected hotkey but
    // robust for a brand-new tile that isn't DOM-measured yet:
    //   1. setCenter on the resolved absolute coords NOW — needs no
    //      measurement/render, so the viewport pans to the tile immediately.
    //   2. once xyflow has measured the node, fitView to frame it nicely
    //      (zoom-to-fit, the focus-selected feel). Poll up to ~1s.
    const z0 = Math.min(Math.max(getZoom(), 0.5), 1);
    void setCenter(req.cx, req.cy, { zoom: z0, duration: 400 });
    let raf = 0;
    let tries = 0;
    const tick = () => {
      const n = getNode(req.id);
      if (n && n.measured?.width && n.measured?.height) {
        void fitView({ nodes: [{ id: req.id }], padding: 0.18, duration: 400, maxZoom: 1 });
        return;
      }
      if (tries++ < 60) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [req, setCenter, getZoom, getNode, fitView]);
  return null;
}

/** Pan inertia: on `req` ({vx,vy} px/ms from the release flick), glide the
 *  viewport to a stop with velocity decay instead of dying instantly.
 *  `activeRef` flips true while flinging so the parent's onMove sampler ignores
 *  our own setViewport calls (no feedback loop). Rendered inside <ReactFlow>. */
function PanMomentum({
  req,
  activeRef,
}: {
  req: { vx: number; vy: number; n: number } | null;
  activeRef: React.MutableRefObject<boolean>;
}) {
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    if (!req) return;
    let raf = 0;
    // Gentle glide: damp the release velocity (×0.45) and cap it so a fast
    // flick doesn't launch the canvas across the screen, and decay quickly
    // (0.85/frame ≈ stops in ~0.25s) so it settles instead of coasting far.
    const cap = (v: number) => Math.max(-1.2, Math.min(1.2, v * 0.45));
    let vx = cap(req.vx);
    let vy = cap(req.vy);
    let last = performance.now();
    activeRef.current = true;
    const tick = (t: number) => {
      const dt = Math.min(t - last, 32);
      last = t;
      vx *= 0.85;
      vy *= 0.85;
      if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
        activeRef.current = false;
        return;
      }
      const vp = getViewport();
      setViewport({ x: vp.x + vx * dt, y: vp.y + vy * dt, zoom: vp.zoom });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      activeRef.current = false;
    };
  }, [req, getViewport, setViewport, activeRef]);
  return null;
}

/** Fly the viewport to a tile by id (used by chip + toast clicks). Must be
 *  rendered inside <ReactFlow> so useReactFlow resolves. */
function useTileFocus(): (id: string) => void {
  const { fitView, getNode } = useReactFlow();
  return useCallback(
    (id: string) => {
      // For PARENTED tiles, `n.position` is RELATIVE to the parent — setCenter
      // on relative coords pans to the wrong place. fitView resolves absolute
      // internally and handles both parented and free nodes. Same fix shape as
      // FocusOnTile / onNodeDragStop's positionAbsolute fallback.
      const n = getNode(id);
      if (!n) return;
      void fitView({ nodes: [{ id }], padding: 0.3, duration: 400, maxZoom: 1 });
    },
    [getNode, fitView],
  );
}

/** Background-event toast stack. Blocked = red (needs you); done = blue. Click
 *  to fly to the tile + dismiss. */
function Toasts({
  toasts,
  onDismiss,
  onView,
}: {
  toasts: { id: string; tileId: string; label: string; status: TileStatusKind }[];
  onDismiss: (id: string) => void;
  onView: (id: string) => void;
}) {
  const focus = useTileFocus();
  return (
    <div className="flex flex-col items-end gap-1.5 max-h-[60vh] overflow-y-auto">
      {toasts.map((t) => {
        const v = statusViz({ label: t.label, status: t.status, seen: false });
        const needsYou =
          t.status === "blocked" || t.status === "permission" || t.status === "question";
        return (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => { focus(t.tileId); onView(t.tileId); }}
            onKeyDown={(ev) => { if (ev.key === "Enter") { focus(t.tileId); onView(t.tileId); } }}
            className="hm-island group flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 cursor-pointer min-w-[180px]"
            style={{ borderColor: v.color }}
          >
            <span
              aria-hidden
              className={`size-2 rounded-full ${v.pulse ? "animate-pulse" : ""}`}
              style={{ background: v.color }}
            />
            <div className="flex flex-col leading-tight">
              <span className="font-mono text-[11px] text-[var(--color-fg)]">{t.label}</span>
              <span className="text-[10px]" style={{ color: v.color }}>
                {needsYou ? "needs your input" : "finished — click to view"}
              </span>
            </div>
            <button
              onClick={(ev) => { ev.stopPropagation(); onDismiss(t.id); }}
              className="ml-auto text-[var(--color-fg3)] hover:text-[var(--color-fg)] opacity-0 group-hover:opacity-100 transition-opacity"
              title="dismiss"
            >×</button>
          </div>
        );
      })}
    </div>
  );
}


function CanvasEmptyState({
  repoPath,
  onShowTree,
  onShowShell,
  onShowDiff,
  onSpawnClaude,
  onInitWorkspace,
}: {
  repoPath: string | null;
  onShowTree: () => void;
  onShowShell: () => void;
  onShowDiff: () => void;
  onSpawnClaude: () => void;
  /** When set (folder open, no .hivemind/), surface an init action. */
  onInitWorkspace?: () => void;
}) {
  // Hierarchy, not a 4-up card grid: one confident primary action (spawn an
  // agent) sits above a quiet row of secondary surface links. Asymmetry +
  // clear weight reads as designed, not generated.
  const secondary = [
    { label: "Open terminal", hint: "⌘T", action: onShowShell, disabled: false },
    { label: "Open workbench", hint: "⌘B", action: onShowTree, disabled: !repoPath },
    { label: "Open diff", hint: "⌘D", action: onShowDiff, disabled: !repoPath },
  ];
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="pointer-events-auto w-full max-w-[440px] px-8">
        <div className="u-eyebrow mb-2">Empty canvas</div>
        <h2 className="text-[20px] font-semibold text-[var(--color-fg)] tracking-tight leading-tight">
          Start with an agent.
        </h2>
        <p className="text-[12.5px] text-[var(--color-fg2)] mt-1.5 leading-relaxed">
          Nothing renders until you ask for it. Spawn Claude, or mount a tool below.
        </p>

        {/* Primary: full-width confident action */}
        <button
          onClick={onSpawnClaude}
          className="mt-5 w-full flex items-center gap-3 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg3)] hover:border-[var(--color-brand)] hover:bg-[var(--color-bg4)] transition-colors px-3.5 py-3 text-left group"
        >
          <span aria-hidden className="grid place-items-center size-8 shrink-0 rounded-md bg-[var(--color-bg4)] text-[var(--color-brand)] group-hover:bg-[var(--color-brand)] group-hover:text-white transition-colors">
            <Sparkles size={16} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-medium text-[var(--color-fg)]">Talk to Claude</span>
            <span className="block text-[11.5px] text-[var(--color-fg3)] leading-snug">A dedicated session in its own tile</span>
          </span>
          <kbd className="font-mono text-[10px] text-[var(--color-fg3)] group-hover:text-[var(--color-fg2)] transition-colors shrink-0">⌘\</kbd>
        </button>

        {/* When launched in a non-hivemind folder, surface init right next to
            the primary action. This is the empty-state path the removed top-left
            switcher used to own; the ⌘K palette has the same item too. */}
        {onInitWorkspace && (
          <button
            onClick={onInitWorkspace}
            className="mt-2 w-full flex items-center gap-3 rounded-lg border border-[var(--color-line2)] hover:border-[var(--color-brand)] hover:bg-[var(--color-bg3)] transition-colors px-3.5 py-2.5 text-left group"
          >
            <span aria-hidden className="grid place-items-center size-7 shrink-0 rounded-md bg-[var(--color-bg3)] text-[var(--color-warn)] group-hover:bg-[var(--color-brand)] group-hover:text-white transition-colors">
              <Sparkles size={14} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px] font-medium text-[var(--color-fg)]">Initialize workspace here…</span>
              <span className="block text-[11px] text-[var(--color-fg3)] leading-snug">Creates a .hivemind/ so issues + agents can run</span>
            </span>
          </button>
        )}

        {/* Secondary: quiet horizontal rule of links */}
        <div className="mt-3 flex items-center gap-1">
          {secondary.map((s) => (
            <button
              key={s.label}
              onClick={s.action}
              disabled={s.disabled}
              title={s.disabled ? "needs an open repo" : s.label}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] transition-colors ${
                s.disabled
                  ? "text-[var(--color-fg3)] opacity-40 cursor-not-allowed"
                  : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
              }`}
            >
              {s.label}
              <kbd className="font-mono text-[9.5px] text-[var(--color-fg3)]">{s.hint}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
