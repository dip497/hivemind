/**
 * Canvas node types — the memoized react-flow node wrappers (terminal / diff /
 * workbench / issues / frame), the per-tile wheel/pan authority hook, the shared
 * NodeResizer props, and the `nodeTypes` map handed to <ReactFlow>. These are
 * pure presentational adapters around the tile components; extracted so Canvas.tsx
 * orchestrates state rather than also declaring the view shells.
 */
import { memo, useEffect, useRef, lazy, Suspense } from "react";
import { NodeResizer, useReactFlow, type NodeTypes } from "@xyflow/react";
import { TerminalTile } from "./TerminalTile";
import { IssuesTile } from "./IssuesTile";
import { FrameNode, type FrameNodeData } from "./FrameNode";
import { TileErrorBoundary } from "./TileErrorBoundary";

const DiffTile = lazy(() => import("./DiffTile").then((m) => ({ default: m.DiffTile })));
const WorkbenchTile = lazy(() => import("./WorkbenchTile").then((m) => ({ default: m.WorkbenchTile })));

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

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // zoom handled by onZoom (capture phase)
      if (selected) {
        // SELECTED tile keeps the wheel for ITS OWN content (terminal
        // scrollback, diff/editor scroll). This listener is in the BUBBLE phase
        // (capture:false below), so the tile content already handled the wheel;
        // we just stop it bubbling so react-flow doesn't ALSO pan.
        e.stopPropagation();
        return;
      }
      // Unselected → two-finger/wheel pans the canvas (capture phase beats the
      // tile's own wheel handler).
      e.preventDefault();
      e.stopPropagation();
      const { x, y, zoom } = getViewport();
      setViewport({ x: x - e.deltaX, y: y - e.deltaY, zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: !selected });

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
      el.removeEventListener("wheel", onZoom, { capture: true });
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
      <TileErrorBoundary label={data.label ?? "terminal"} onClose={data.onClose}>
        <TerminalTile {...data} selected={selected} />
      </TileErrorBoundary>
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
      <TileErrorBoundary label="Diff" onClose={data.onClose}>
        <Suspense fallback={<TileLoading label="Loading diff…" />}>
          <DiffTile {...data} />
        </Suspense>
      </TileErrorBoundary>
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
      <TileErrorBoundary label="Editor" onClose={data.onClose}>
        <Suspense fallback={<TileLoading label="Loading editor…" />}>
          <WorkbenchTile
            repoPath={data.repoPath}
            tabs={data.tabs}
            onOpenFile={data.onOpenFile}
            onCloseTab={data.onCloseTab}
            onClose={data.onClose}
          />
        </Suspense>
      </TileErrorBoundary>
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
      <TileErrorBoundary label="Issues" onClose={data.onClose}>
        <IssuesTile root={data.root} onClose={data.onClose} />
      </TileErrorBoundary>
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

export const nodeTypes: NodeTypes = {
  terminal: TerminalNode as unknown as NodeTypes[string],
  diff: DiffNode as unknown as NodeTypes[string],
  workbench: WorkbenchNode as unknown as NodeTypes[string],
  issues: IssuesNode as unknown as NodeTypes[string],
  frame: FrameNodeWrapper as unknown as NodeTypes[string],
};
