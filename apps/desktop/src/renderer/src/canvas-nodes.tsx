/**
 * Canvas node types — the memoized react-flow node wrappers (terminal / diff /
 * workbench / issues / frame), the per-tile wheel/pan authority hook, the shared
 * NodeResizer props, and the `nodeTypes` map handed to <ReactFlow>. These are
 * pure presentational adapters around the tile components; extracted so Canvas.tsx
 * orchestrates state rather than also declaring the view shells.
 *
 * Pinned tiles: a pinned tile stays a react-flow node for BOOKKEEPING, but its
 * content is rendered via `createPortal` into a fixed, non-transformed screen-space
 * layer (`PinnedLayerContext`). Because that layer isn't inside react-flow's
 * transformed viewport, the panel is inherently screen-fixed + constant-size —
 * completely unaffected by canvas pan/zoom. The React instance is preserved by the
 * portal move; only a `<webview>` browser tile reloads once (an inherent Chromium
 * reparent limit). See TileShell + FloatingPinnedPanel below.
 */
import {
  memo, useCallback, useContext, useEffect, useRef, useState, lazy, Suspense,
  createContext, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { NodeResizer, useReactFlow, type NodeTypes } from "@xyflow/react";
import { Pin, X } from "lucide-react";
import { clampAnchor } from "./pin-anchor";
import { TerminalTile } from "./TerminalTile";
import { BrowserTile } from "./BrowserTile";
import { IssuesTile } from "./IssuesTile";
import { PlanReviewTile } from "./PlanReviewTile";
import { FrameNode, type FrameNodeData } from "./FrameNode";
import { TileErrorBoundary } from "./TileErrorBoundary";

const DiffTile = lazy(() => import("./DiffTile").then((m) => ({ default: m.DiffTile })));
const WorkbenchTile = lazy(() => import("./WorkbenchTile").then((m) => ({ default: m.WorkbenchTile })));

/** Screen-space rect captured from a tile's DOM at pin time (SCREEN pixels). */
export type PinRect = { sx: number; sy: number; w: number; h: number };

/** The DOM node every pinned tile portals its floating panel into. Canvas mounts a
 *  single fixed full-window `<div id="hm-pinned-layer">` and provides it here; the
 *  node wrappers `useContext` it. A React context (vs getElementById) keeps the
 *  reference stable across re-renders and re-renders portals when it first mounts. */
export const PinnedLayerContext = createContext<HTMLElement | null>(null);

type TerminalNodeData = {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  label?: string;
  name?: string;
  onRename?: (id: string, name: string) => void;
  onAgentTitle?: (id: string, title: string) => void;
  onOpenInBrowser?: (url: string) => void;
  onOpenInEditor?: (path: string) => void;
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
  onOpenInBrowser?: (url: string) => void;
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
  color: "var(--color-select)",
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
/** Pin state + callbacks injected onto every tile's data by mkTile. */
export type ShellPin = {
  pinned?: boolean;
  pinAnchor?: { sx: number; sy: number };
  pinSize?: { w: number; h: number };
  /** Pin/unpin. On pin, `rect` is the tile's current SCREEN rect (top-left +
   *  size, from its DOM getBoundingClientRect); ignored on unpin. */
  onTogglePin?: (id: string, rect: PinRect) => void;
  /** Drag/resize of the floating panel → persist the new anchor and/or size. */
  onPinChange?: (id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => void;
};

type WithResize<T> = T & {
  onResize: (id: string, w: number, h: number, x?: number, y?: number) => void;
} & ShellPin;

/** Corner badge that pins/unpins a tile. On PIN it measures the tile's DOM rect in
 *  SCREEN pixels (getBoundingClientRect is already viewport-relative) and hands
 *  that rect up, so the floating panel opens exactly where — and the size — the
 *  tile currently is. Hidden until node-hover unless already pinned. */
function PinToggle({ id, pinned, onToggle }: {
  id: string;
  pinned?: boolean;
  onToggle?: (id: string, rect: PinRect) => void;
}) {
  if (!onToggle) return null;
  const handle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nodeEl = (e.currentTarget as HTMLElement).closest(".react-flow__node") as HTMLElement | null;
    if (!nodeEl) { onToggle(id, { sx: 80, sy: 80, w: 640, h: 420 }); return; }
    const r = nodeEl.getBoundingClientRect();
    onToggle(id, { sx: r.left, sy: r.top, w: r.width, h: r.height });
  };
  return (
    <button
      onClick={handle}
      className={`nodrag absolute -top-3 -left-3 z-20 size-6 grid place-items-center rounded-full border shadow-md cursor-pointer transition-opacity ${
        pinned
          ? "opacity-100 bg-[var(--color-brand)] border-[var(--color-brand)] text-white"
          : "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 bg-[var(--color-bg3)] border-[var(--color-line)] text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
      }`}
      title={pinned ? "Unpin — return to canvas" : "Pin — float fixed on screen"}
      aria-label={pinned ? "Unpin tile" : "Pin tile"}
      aria-pressed={!!pinned}
    >
      <Pin size={12} className={pinned ? "fill-current" : ""} />
    </button>
  );
}

// Minimum floating-panel size — matches the in-canvas resizer floor so a pinned
// tile can't be shrunk below a usable size.
const PIN_MIN_W = 280;
const PIN_MIN_H = 180;

/** The screen-fixed floating panel a pinned tile renders into (portaled by
 *  TileShell into the fixed pinned layer). Absolutely positioned in SCREEN pixels;
 *  constant size; a header with a drag handle + unpin + close; and a bottom-right
 *  corner handle to resize. Drag/resize keep the panel clamped inside the window
 *  and commit the new anchor/size via `onChange` so they persist.
 *
 *  NOTE: portaling reparents the tile's DOM into this fixed layer. Canvas/terminal
 *  content survives the move (terminals also reattach to their persistent daemon
 *  PTY), but a `<webview>` browser tile reloads its page ONCE on reparent — an
 *  inherent Chromium limitation, accepted. */
function FloatingPinnedPanel({ id, anchor, size, onUnpin, onChange, onClose, children }: {
  id: string;
  anchor?: { sx: number; sy: number };
  size?: { w: number; h: number };
  onUnpin?: (id: string, rect: PinRect) => void;
  onChange?: (id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState(() => anchor ?? { sx: 80, sy: 80 });
  const [dim, setDim] = useState(() => size ?? { w: 640, h: 420 });
  // Re-sync from persisted values when they change externally (e.g. a re-pin
  // captures a fresh rect). Live drag/resize below owns them in between.
  const draggingRef = useRef(false);
  useEffect(() => { if (anchor && !draggingRef.current) setPos(anchor); }, [anchor?.sx, anchor?.sy]);
  useEffect(() => { if (size && !draggingRef.current) setDim(size); }, [size?.w, size?.h]);

  const win = () => ({ w: window.innerWidth, h: window.innerHeight });

  // Header drag → reposition, clamped inside the window; commit on release.
  const onHeaderDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    const startX = e.clientX, startY = e.clientY;
    const base = pos;
    let cur = pos;
    const move = (ev: PointerEvent) => {
      const next = clampAnchor(
        { sx: base.sx + (ev.clientX - startX), sy: base.sy + (ev.clientY - startY) },
        dim, win(),
      );
      cur = next;
      setPos(next);
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onChange?.(id, { anchor: cur });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [pos, dim, id, onChange]);

  // Bottom-right corner drag → resize; commit on release. Also re-clamps the
  // anchor so a grown panel can't push its header off-screen.
  const onCornerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    const startX = e.clientX, startY = e.clientY;
    const base = dim;
    let cur = dim;
    const move = (ev: PointerEvent) => {
      cur = {
        w: Math.max(PIN_MIN_W, base.w + (ev.clientX - startX)),
        h: Math.max(PIN_MIN_H, base.h + (ev.clientY - startY)),
      };
      setDim(cur);
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const clamped = clampAnchor(pos, cur, win());
      setPos(clamped);
      onChange?.(id, { size: cur, anchor: clamped });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [dim, pos, id, onChange]);

  return (
    <div
      className="hm-pinned-panel fixed flex flex-col rounded-xl overflow-hidden"
      style={{ left: pos.sx, top: pos.sy, width: dim.w, height: dim.h, pointerEvents: "auto", zIndex: 55 }}
    >
      {/* Header: drag handle + unpin + close. `nodrag` is irrelevant here (we're
          outside react-flow), but the class keeps parity with tile chrome. */}
      <div
        onPointerDown={onHeaderDown}
        className="hm-pinned-header shrink-0 flex items-center gap-1 h-7 px-1.5 cursor-grab active:cursor-grabbing select-none"
      >
        <Pin size={11} className="fill-current text-[var(--color-brand)] shrink-0" />
        <span className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onUnpin?.(id, { sx: pos.sx, sy: pos.sy, w: dim.w, h: dim.h }); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
          title="Unpin — return to canvas"
          aria-label="Unpin tile"
        >
          <Pin size={12} />
        </button>
        {onClose && (
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
            title="Close tile"
            aria-label="Close tile"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {/* Tile content — the SAME React tree, portaled here. */}
      <div className="relative flex-1 min-h-0">{children}</div>
      {/* Bottom-right resize handle. */}
      <div
        onPointerDown={onCornerDown}
        className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
        style={{ touchAction: "none" }}
        aria-label="Resize pinned tile"
      />
    </div>
  );
}

/** Shared shell for every tile node. Unpinned: renders the tile inline with the
 *  pin badge + NodeResizer. Pinned: portals the SAME content into the fixed
 *  pinned layer as a screen-fixed floating panel, and renders nothing in-canvas
 *  (the node still exists in react-flow for id/bookkeeping). */
function TileShell({
  id, selected, pin, onClose, onResize, minWidth, minHeight, wheelRef, children,
}: {
  id: string;
  selected: boolean;
  pin: ShellPin;
  onClose?: () => void;
  onResize: (id: string, w: number, h: number, x?: number, y?: number) => void;
  minWidth?: number;
  minHeight?: number;
  wheelRef: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const pinnedLayer = useContext(PinnedLayerContext);
  if (pin.pinned && pinnedLayer) {
    // In-canvas footprint renders nothing (the portal moves the content out); the
    // node keeps its react-flow identity but has no visible body.
    return createPortal(
      <FloatingPinnedPanel
        id={id}
        anchor={pin.pinAnchor}
        size={pin.pinSize}
        onUnpin={pin.onTogglePin}
        onChange={pin.onPinChange}
        onClose={onClose}
      >
        {children}
      </FloatingPinnedPanel>,
      pinnedLayer,
    );
  }
  return (
    <div className={`group/tile w-full h-full nowheel${selected ? " hm-node-selected" : " tile-locked"}`} ref={wheelRef}>
      <PinToggle id={id} pinned={pin.pinned} onToggle={pin.onTogglePin} />
      <NodeResizer
        nodeId={id}
        isVisible={selected}
        {...RESIZER_PROPS}
        minWidth={minWidth ?? RESIZER_PROPS.minWidth}
        minHeight={minHeight ?? RESIZER_PROPS.minHeight}
        onResizeEnd={(_e, p) => onResize(id, p.width, p.height, p.x, p.y)}
      />
      {children}
    </div>
  );
}

// Does this tile OWN the wheel — i.e. does it contain scrollable content the
// wheel should drive instead of panning the canvas? This is deliberately
// POSITION-INDEPENDENT (it asks "could this scroll?", not "is there room left in
// this direction?"). That's the key to killing the trackpad-momentum leak: if we
// only suppressed the pan while there was scroll room, hitting the boundary
// mid-flick would flip to panning and the inertia tail would jerk the canvas.
// By owning the whole wheel whenever the tile has any scroller, there is no
// scroll↔pan transition for momentum to exploit — the wheel scrolls the content,
// and at the edge it simply stops (overscroll-behavior:contain keeps it there).
function tileOwnsWheel(el: HTMLElement, target: EventTarget | null): boolean {
  // Terminal fast path: xterm's scrollable `.xterm-viewport` is a SIBLING of the
  // `.xterm-screen` the cursor hits, so the ancestor walk would miss it. A
  // terminal always owns the wheel (you never pan the board by scrolling a
  // terminal — predictable, and matches every editor/terminal UI).
  if (el.querySelector(".xterm-viewport")) return true;
  // Other tiles (diff / editor / markdown / lists): own the wheel if a
  // native-scroll ancestor of the cursor target has overflowing content. This
  // stays true at the scroll boundary (scrollHeight > clientHeight regardless of
  // scrollTop), so the momentum tail can't leak into a pan.
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== el.parentElement) {
    const ov = getComputedStyle(node);
    const sy = ov.overflowY === "auto" || ov.overflowY === "scroll";
    const sx = ov.overflowX === "auto" || ov.overflowX === "scroll";
    if ((sy && node.scrollHeight > node.clientHeight) || (sx && node.scrollWidth > node.clientWidth)) return true;
    node = node.parentElement;
  }
  return false;
}

// Single wheel authority for a tile, via a NATIVE non-passive listener (React's
// synthetic wheel handlers are passive — preventDefault is a no-op). Every tile
// carries `nowheel` so react-flow's own panOnScroll/zoom never fires over a tile;
// THIS handler is the sole decider of scroll-vs-pan over a tile:
//   • Ctrl/⌘ + wheel              → zoom the canvas toward the cursor (always).
//   • SELECTED tile               → content owns the wheel (xterm/diff/editor); no pan.
//   • internal scroll under cursor → let that element scroll; no pan. (This is the
//                                    "don't pan while the terminal still has
//                                    scrollback under the cursor" behaviour.)
//   • otherwise (unselected, no inner scroll / at boundary) → pan the canvas.
function useTileWheelZoom(selected: boolean): React.RefObject<HTMLDivElement | null> {
  const { getViewport, setViewport, screenToFlowPosition } = useReactFlow();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Ctrl/Cmd+wheel ZOOMS the canvas — even over a tile and even when the tile
    // is selected. Runs in the CAPTURE phase (always) so it beats xterm's own
    // wheel handler; otherwise a selected terminal would scroll instead of zoom.
    const onZoom = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y, zoom } = getViewport();
      const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(2.5, Math.max(0.25, zoom * factor));
      setViewport({ x: x + f.x * (zoom - next), y: y + f.y * (zoom - next), zoom: next });
    };
    el.addEventListener("wheel", onZoom, { passive: false, capture: true });

    // BUBBLE phase: the tile content (xterm/diff/editor) gets the wheel FIRST
    // and scrolls itself; `nowheel` on the wrapper keeps react-flow out entirely,
    // so a no-op here means "the content scrolled, the canvas did NOT pan".
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // zoom handled by onZoom (capture phase)
      // A selected tile always keeps the wheel for its own content (matches the
      // focus model; also covers Monaco, which scrolls via transform not native
      // overflow). Any tile that owns scrollable content keeps it too — and at
      // the scroll boundary the wheel just stops, it does NOT flip into a pan
      // (the trackpad-momentum leak). Only a tile with NO scroller pans.
      if (selected || tileOwnsWheel(el, e.target)) return;
      e.preventDefault();
      const { x, y, zoom } = getViewport();
      setViewport({ x: x - e.deltaX, y: y - e.deltaY, zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: false });

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
      // MIDDLE-button drag pans the canvas ANYWHERE — even over a selected tile.
      // On Linux a 3-finger trackpad drag is commonly routed to the middle
      // button, so this is the closest thing to "3-finger pans the panel" the
      // web platform can see (it never exposes finger count). RIGHT-button pan
      // stays unselected-only so a selected tile keeps its own right-click use.
      const isMiddle = ev.button === 1;
      const isRight = ev.button === 2;
      if (!isMiddle && !(isRight && !selected)) return;
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
      el.removeEventListener("wheel", onZoom, { capture: true });
      el.removeEventListener("wheel", onWheel);
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
    <TileShell id={id} selected={selected} pin={data} onClose={data.onClose} onResize={data.onResize} wheelRef={wheelRef}>
      <TileErrorBoundary label={data.label ?? "terminal"} onClose={data.onClose}>
        <TerminalTile {...data} selected={selected} />
      </TileErrorBoundary>
    </TileShell>
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
    <TileShell id={id} selected={selected} pin={data} onClose={data.onClose} onResize={data.onResize} minWidth={400} minHeight={240} wheelRef={wheelRef}>
      <TileErrorBoundary label="Diff" onClose={data.onClose}>
        <Suspense fallback={<TileLoading label="Loading diff…" />}>
          <DiffTile {...data} />
        </Suspense>
      </TileErrorBoundary>
    </TileShell>
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
    <TileShell id={id} selected={selected} pin={data} onClose={data.onClose} onResize={data.onResize} minWidth={520} minHeight={360} wheelRef={wheelRef}>
      <TileErrorBoundary label="Editor" onClose={data.onClose}>
        <Suspense fallback={<TileLoading label="Loading editor…" />}>
          <WorkbenchTile
            repoPath={data.repoPath}
            tabs={data.tabs}
            onOpenFile={data.onOpenFile}
            onOpenInBrowser={data.onOpenInBrowser}
            onCloseTab={data.onCloseTab}
            onClose={data.onClose}
          />
        </Suspense>
      </TileErrorBoundary>
    </TileShell>
  );
});

type BrowserNodeData = {
  tileId: string;
  frameId?: string | null;
  url?: string;
  openReq?: { url: string; seq: number } | null;
  onClose?: () => void;
};
const BrowserNode = memo(function BrowserNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: WithResize<BrowserNodeData>;
  selected: boolean;
}) {
  const wheelRef = useTileWheelZoom(selected);
  return (
    <TileShell id={id} selected={selected} pin={data} onClose={data.onClose} onResize={data.onResize} minWidth={420} minHeight={280} wheelRef={wheelRef}>
      <TileErrorBoundary label="Browser" onClose={data.onClose}>
        <BrowserTile
          tileId={data.tileId}
          frameId={data.frameId}
          url={data.url}
          openReq={data.openReq}
          selected={selected}
          onClose={data.onClose}
        />
      </TileErrorBoundary>
    </TileShell>
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
    <TileShell id={id} selected={selected} pin={data} onClose={data.onClose} onResize={data.onResize} minWidth={280} wheelRef={wheelRef}>
      <TileErrorBoundary label="Issues" onClose={data.onClose}>
        <IssuesTile root={data.root} onClose={data.onClose} selected={selected} />
      </TileErrorBoundary>
    </TileShell>
  );
});

type PlanReviewNodeData = {
  requestId?: string;
  hcpCmdId?: string;
  plan: string;
  cwd: string;
  agentTileId?: string;
  onClose?: () => void;
};
const PlanReviewNode = memo(function PlanReviewNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: WithResize<PlanReviewNodeData>;
  selected: boolean;
}) {
  const wheelRef = useTileWheelZoom(selected);
  return (
    <TileShell id={id} selected={selected} pin={data} onClose={data.onClose} onResize={data.onResize} minWidth={420} minHeight={300} wheelRef={wheelRef}>
      <TileErrorBoundary label="Plan review" onClose={data.onClose}>
        <PlanReviewTile {...data} />
      </TileErrorBoundary>
    </TileShell>
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

export const nodeTypes: NodeTypes = {
  terminal: TerminalNode as unknown as NodeTypes[string],
  diff: DiffNode as unknown as NodeTypes[string],
  workbench: WorkbenchNode as unknown as NodeTypes[string],
  issues: IssuesNode as unknown as NodeTypes[string],
  browser: BrowserNode as unknown as NodeTypes[string],
  planReview: PlanReviewNode as unknown as NodeTypes[string],
  frame: FrameNodeWrapper as unknown as NodeTypes[string],
};
