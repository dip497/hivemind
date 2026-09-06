/**
 * CanvasView — the infinite-canvas view plugin (xyflow). The Layers rail on the
 * left, react-flow in the middle, the Excalidraw-style islands floating over it.
 *
 * This is the PRESENTATION that used to be the bottom half of Canvas.tsx. It
 * builds react-flow nodes from the workspace model + the runtime-hosted canvas
 * geometry (`useCanvasRuntime` — see canvas-runtime.ts for why the geometry is
 * not local yet), owns the camera feel (pan momentum, crisp snapping, motion
 * compositing classes) and the canvas-only chrome (islands, minimap, zen,
 * theme customizer, pinned layer). Tile BODIES are not here: each tile node is a
 * `<TileSlot>` the shared TileHost fills, so react-flow may mount/unmount nodes
 * freely without touching a live session.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import { Eye, EyeOff, LayoutGrid } from "lucide-react";
import { LayersPanel } from "../../LayersPanel";
import { ToolIsland, ZoomIsland } from "../../canvas-islands";
import { ThemeCustomizer } from "../../ThemeCustomizer";
import { CanvasEmptyState, Toasts } from "../../canvas-overlays";
import { nodeTypes, PinnedLayerContext } from "../../canvas-nodes";
import { pipeEdgeTypes } from "../../canvas-pipe-edge";
import { useOnViewportChange } from "@xyflow/react";
import { snapViewportCrisp, FocusMode, FocusOnTile, PanMomentum, ViewportSnap } from "../../canvas-camera";
import { buildBaseNodes } from "../../canvas-node-build";
import type { WorkspaceViewPlugin, WorkspaceViewProps } from "../workspace-view";
import { useCanvasRuntime } from "./canvas-runtime";

// Stable references for props passed to <ReactFlow>. The xyflow perf guide
// (reactflow.dev/learn/advanced-use/performance) flags unmemoized object/array
// props as the #1 cause of re-renders during node movement — a fresh `edges={[]}`
// or inline `panOnDrag={[1,2]}` every render makes react-flow re-process its
// internal state each frame. Hoisting them to module scope makes the ref constant.
const EMPTY_EDGES: Edge[] = [];
const PAN_ON_DRAG = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };

/** Keeps the runtime's viewport ref equal to react-flow's ACTUAL viewport —
 *  every change, user or programmatic (the crisp snap, focus flights, momentum),
 *  via `useOnViewportChange`; `onMove` alone misses programmatic moves. A
 *  remount (view round trip, crash fallback, Retry) reads the ref as
 *  `defaultViewport`, so the camera resumes exactly where it was. Deliberately
 *  NO read-back on unmount: react-flow resets its store in its own (parent,
 *  earlier) cleanup, so a read there yields the identity viewport. */
function ViewportMirror({ target }: { target: { current: { x: number; y: number; zoom: number } } }) {
  useOnViewportChange({
    onChange: (vp) => { target.current = vp; },
    onEnd: (vp) => { target.current = vp; },
  });
  return null;
}

export function CanvasView({ model, commands }: WorkspaceViewProps) {
  const rt = useCanvasRuntime();
  const {
    repoPath, tiles, frames, frameOf, selectedTileId,
    layerTiles, layerFrames, frameActions, links,
  } = model;
  const { selectTile, focusTile, closeTile, spawnVis, spawnClaude, addFrame } = commands;

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

  // Camera requests live in the runtime and outlive this view. The ones that
  // already existed when we mounted were consumed by a PREVIOUS canvas mount —
  // replaying them would fly the camera back to an old tile right after a
  // view round trip and undo the viewport we just restored. Only react to
  // requests issued after mount.
  const [mountFocusReq] = useState(() => rt.focusReq);
  const [mountFocusModeReq] = useState(() => rt.focusModeReq);
  const focusReq = rt.focusReq === mountFocusReq ? null : rt.focusReq;
  const focusModeReq = rt.focusModeReq === mountFocusModeReq ? null : rt.focusModeReq;

  // The fixed full-window layer pinned tiles portal their floating panels into.
  // A ref-callback captures the DOM node into state so the context re-renders the
  // node wrappers once it mounts (portals need a live target). See the render.
  const [pinnedLayer, setPinnedLayer] = useState<HTMLDivElement | null>(null);

  const focusTileFromPanel = useCallback((id: string) => {
    selectTile(id);
    // Clicking a tile in the Layers panel must focus it EXACTLY like clicking it
    // on the canvas (onNodeClick) — not the older fit-to-screen zoom-out. Text
    // tiles (terminal/shell/diff/editor) snap to 100% with the content-corner
    // clamp; the rest get the framed focus. Mirrors the onNodeClick decision.
    const kind = tiles.find((x) => x.id === id)?.kind;
    const exact = kind === "claude" || kind === "shell" || kind === "diff" || kind === "editor";
    focusTile(id, { exact });
  }, [selectTile, focusTile, tiles]);
  const focusFrameFromPanel = useCallback((id: string) => {
    commands.selectFrame(id);
    selectTile(null);
    focusTile(id);
  }, [commands, selectTile, focusTile]);

  // baseNodes: built WITHOUT selectedTileId. Rebuilds whenever any layout /
  // frame / size / position state changes; the selection-derived `nodes` memo
  // below shallow-clones only the selected node so a click doesn't churn
  // React.memo on the heavy wrappers. Pure — see canvas-node-build.ts.
  const baseNodes: Node[] = useMemo(() => buildBaseNodes({
    repoPath, tiles, frames, frameOf, pinnedIds: rt.pinnedIds, sizes: rt.sizes, positions: rt.positions,
    frameTiles: rt.frameTiles, framesChipNames: rt.framesChipNames,
    updateFrameTitle: rt.updateFrameTitle, updateFrameColor: rt.updateFrameColor, deleteFrame: rt.deleteFrame,
    arrangeFrame: rt.arrangeFrame, bringFrameToFront: rt.bringFrameToFront,
    onAttachWorktree: rt.onAttachWorktree, onCreateWorktree: rt.onCreateWorktree, unbindBranch: rt.unbindBranch,
    bindWorkspace: rt.bindWorkspace, unbindWorkspace: rt.unbindWorkspace,
    closeTile, onNodeResizeCommit: rt.onNodeResizeCommit, onTogglePin: rt.togglePin, onPinChange: rt.onPinChange,
  }), [
    repoPath, tiles, frames, frameOf, rt.pinnedIds, rt.sizes, rt.positions, rt.frameTiles, rt.framesChipNames,
    rt.updateFrameTitle, rt.updateFrameColor, rt.deleteFrame, rt.arrangeFrame, rt.bringFrameToFront,
    rt.onAttachWorktree, rt.onCreateWorktree, rt.unbindBranch, rt.bindWorkspace, rt.unbindWorkspace,
    closeTile, rt.onNodeResizeCommit, rt.togglePin, rt.onPinChange,
  ]);
  // Derive selection-aware nodes from baseNodes. Shallow-clones ONLY the
  // currently-selected tile so other nodes keep their object identity →
  // React.memo skips them. Frames keep their own z stacking.
  const nodes: Node[] = useMemo(() => {
    // No selection (the common case): baseNodes already carries every node's
    // zIndex (tiles 100 via mkTile, frames their own), so return it VERBATIM —
    // same array + node refs, zero allocation, no memo break. Pinned tiles need
    // NO special node treatment here: their content is portaled out to the fixed
    // pinned layer by the node wrapper, so the in-canvas node is just an inert,
    // empty bookkeeping node at its normal position.
    if (!selectedTileId) return baseNodes;
    return baseNodes.map((n) => {
      if (n.type === "frame" || n.id !== selectedTileId) return n;
      return { ...n, selected: true, style: { ...(n.style ?? {}), zIndex: 1000 } };
    });
  }, [baseNodes, selectedTileId]);
  // Agent pipes (hive_connect) → animated "data flow" edges; spawn wires →
  // dashed parentage edges. Only between endpoints that still exist as tiles.
  const edges = useMemo<Edge[]>(() => {
    const { pipes, spawnLinks } = links;
    if (pipes.length === 0 && spawnLinks.length === 0) return EMPTY_EDGES;
    const ids = new Set(tiles.map((t) => t.id));
    // Spawn wires (dashed parentage, parent → child) sit UNDER the animated data
    // pipes. A pipe between the same pair visually wins (higher zIndex).
    const spawnEdges: Edge[] = spawnLinks
      .filter((l) => ids.has(l.parent) && ids.has(l.child))
      .map((l) => ({ id: `spawn-${l.parent}-${l.child}`, source: l.parent, target: l.child, type: "spawn", zIndex: 1900 }));
    const pipeEdges: Edge[] = pipes
      .filter((p) => ids.has(p.src) && ids.has(p.dst))
      .map((p) => ({ id: `flow-${p.src}-${p.dst}`, source: p.src, target: p.dst, type: "dataflow", zIndex: 2000 }));
    return [...spawnEdges, ...pipeEdges];
  }, [links, tiles]);

  // MiniMap is opt-in — its `pannable zoomable` re-renders every node mini-rect
  // on every pan/zoom frame, a real cost with several live tiles. Off by default.
  const [minimapOn, setMinimapOn] = useState(false);
  const showMinimap = minimapOn && nodes.length > 0;
  // Zen mode — hide ALL canvas chrome (tool island, zoom island, minimap, Layers
  // panel) for a clean full-canvas view. The eye toggle stays so you can restore.
  const [zen, setZen] = useState<boolean>(() => localStorage.getItem("hivemind:zen") === "1");
  useEffect(() => { localStorage.setItem("hivemind:zen", zen ? "1" : "0"); }, [zen]);
  // Appearance customizer (glass / wallpaper / accent).
  const [customizerOpen, setCustomizerOpen] = useState(false);

  const isEmpty = nodes.length === 0;

  // Motion-aware compositing: while the viewport pans/zooms we add a class that
  // (a) kills tile pointer-events (no hit-test churn) and (b) clips each tile's
  // paint via `contain` so the browser composites fewer/cheaper layers. Restored
  // shortly after motion stops. See styles.css `.canvas-moving`.
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
  const { currentViewportRef, setViewport } = rt;
  const onMove = useCallback((_: unknown, vp: { x: number; y: number; zoom: number }) => {
    currentViewportRef.current = vp;
    if (inMomentumRef.current) return; // ignore self-generated moves
    const s = panSamplesRef.current;
    s.push({ t: performance.now(), x: vp.x, y: vp.y });
    if (s.length > 6) s.shift();
  }, [currentViewportRef]);
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
    // Commit the post-pan viewport so the layout blob persists it — ONE re-render
    // at the end of the pan (not per pointermove). When the canvas comes to REST
    // (no fling), snap it crisp: xterm rasterizes glyphs to a canvas the
    // react-flow viewport then CSS-transforms; a fractional translate lands that
    // bitmap on sub-pixels → fuzzy text. Rounding the pan to the device-pixel
    // grid and snapping a near-1 zoom to exactly 1 keeps text sharp at rest.
    const committed = flung ? currentViewportRef.current : snapViewportCrisp(currentViewportRef.current);
    currentViewportRef.current = committed;
    setViewport(committed);
    if (!flung) bumpSnap(); // snap the LIVE transform too (a fling snaps on settle)
  }, [bumpSnap, currentViewportRef, setViewport]);
  // Dragging a TILE is a node drag (not a viewport move) so onMoveStart never
  // fires for it. Use a SEPARATE class with compositing hints only (NOT
  // pointer-events:none, which would drop the drag gesture mid-move).
  const onNodeDragStart = useCallback(() => {
    flowWrapRef.current?.classList.add("canvas-dragging");
  }, []);
  // Remove the class SYNCHRONOUSLY on drop, BEFORE the runtime's drag-stop
  // commits positions (its setState flushes after this handler returns), so
  // the `.react-flow__node` transition is active when xyflow re-syncs the
  // node's transform to the snapped target — that travel is the "smooth land".
  const { handleNodeDragStop } = rt;
  const onNodeDragStop = useCallback((e: unknown, node: Node) => {
    flowWrapRef.current?.classList.remove("canvas-dragging");
    handleNodeDragStop(e, node);
  }, [handleNodeDragStop]);
  // On unmount, capture the viewport react-flow ACTUALLY shows from the DOM
  // transform. xyflow's scroll-pan only reports a move once a second wheel
  // event arrives, so a lone wheel tick changes the transform without any
  // onMove/onMoveEnd/onViewportChange — the ref and the persisted viewport would
  // both miss it and a remount would snap back. Layout-effect cleanup runs
  // before the DOM is removed, and before react-flow resets its own store.
  const { setViewport: commitViewport } = rt;
  useLayoutEffect(() => () => {
    const vp = flowWrapRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(vp?.style.transform ?? "");
    if (!m) return;
    const live = { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
    if (!Number.isFinite(live.x) || !Number.isFinite(live.y) || !Number.isFinite(live.zoom)) return;
    currentViewportRef.current = live;
    commitViewport(live);
  }, [currentViewportRef, commitViewport]);

  // Tile BODIES are portaled from the TileHost and only DOM-reparented into the
  // node, so React synthetic events from inside a body never reach xyflow's
  // NodeWrapper → `onNodeClick` below never fires for a body click. The shared
  // layer already SELECTS on native pointerdown (tile-host.tsx); this native
  // click listener adds the canvas-only part of onNodeClick — seen-tracking,
  // the crisp snap, and the exact 1:1 focus on a NEW selection — and the
  // context-menu suppression that the React handler can't see either. Clicks
  // that travelled >4px (a header drag) are ignored, like nodeClickDistance.
  const selectTileRef = useRef(selectTile); selectTileRef.current = selectTile;
  const focusTileRef = useRef(focusTile); focusTileRef.current = focusTile;
  useEffect(() => {
    const wrap = flowWrapRef.current;
    if (!wrap) return;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest(".hm-tile-surface")) return; // shell parts still reach onNodeClick
      const node = t.closest(".react-flow__node") as HTMLElement | null;
      const id = node?.getAttribute("data-id");
      if (!node || !id || node.classList.contains("react-flow__node-frame")) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const isNewSelection = !rt.selectedTileIdsRef.current.has(id);
      selectTileRef.current(id);
      rt.selectedTileIdsRef.current = new Set([id]);
      rt.markSeen([id]);
      bumpSnap();
      if (isNewSelection && /react-flow__node-(terminal|diff|editor|workbench)/.test(node.className)) {
        focusTileRef.current(id, { exact: true });
      }
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    wrap.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    wrap.addEventListener("click", onClick);
    wrap.addEventListener("contextmenu", onContextMenu);
    return () => {
      wrap.removeEventListener("pointerdown", onDown, { capture: true });
      wrap.removeEventListener("click", onClick);
      wrap.removeEventListener("contextmenu", onContextMenu);
    };
  }, [rt.selectedTileIdsRef, rt.markSeen, bumpSnap]);
  // NodeResizer sets body.canvas-resizing on resize start; clear it when the
  // pointer is released (resize ends on pointerup, anywhere).
  useEffect(() => {
    const clear = () => document.body.classList.remove("canvas-resizing");
    document.addEventListener("pointerup", clear);
    return () => document.removeEventListener("pointerup", clear);
  }, []);

  // Compositor layer pre-promotion via MDN's "via_a_script" pattern. On
  // pointerdown over a heavy tile's drag handle, set `will-change: transform`
  // so Blink uploads the layer to the GPU BEFORE xyflow's drag-threshold trips
  // (~50-150ms head start). Cleared on pointerup/cancel. Only ONE element
  // promoted at a time — no layer explosion. Frames excluded (huge surface).
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

  return (
    <PinnedLayerContext.Provider value={pinnedLayer}>
      {/* Screen-fixed layer pinned tiles portal their floating panels into. Fixed
          full-window + pointer-events:none so it never blocks the canvas or the
          tool-island Panels; each floating panel re-enables pointer-events on
          itself. Sits above tiles (z ~55) yet below modal overlays. Because it's
          OUTSIDE react-flow's transformed viewport, its content is inherently
          screen-fixed + constant-size — unaffected by pan/zoom. */}
      <div
        id="hm-pinned-layer"
        ref={setPinnedLayer}
        className="fixed inset-0 pointer-events-none"
        style={{ zIndex: 50 }}
      />
      {/* t3code-style DOCKED layout: the Layers panel is a flex SIBLING of the
          canvas (not an overlay), so the canvas sits BESIDE it and is never
          occluded. Collapses to a narrow icon rail; both keep the canvas clear. */}
      <div className="flex-1 min-h-0 flex flex-row">
        {!zen && layerTiles.length > 0 && (
          <LayersPanel
            frames={layerFrames}
            tiles={layerTiles}
            selectedTileId={selectedTileId}
            onFocusTile={focusTileFromPanel}
            onFocusFrame={focusFrameFromPanel}
            frameActions={frameActions}
          />
        )}
        {/* The native contextmenu listener above suppresses the menu so RIGHT-
            mouse drag pans (panOnDrag=[1,2]) instead of popping a menu that
            aborts the drag — native, so it also covers portaled tile bodies. */}
        <div ref={flowWrapRef} className="relative flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={pipeEdgeTypes}
          defaultViewport={rt.currentViewportRef.current}
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
              selectTile(null);
            } else {
              // Re-frame only when selecting a DIFFERENT tile — re-clicking the
              // already-selected tile (e.g. to type) must NOT yank the viewport.
              const isNewSelection = !rt.selectedTileIdsRef.current.has(node.id);
              selectTile(node.id);
              rt.selectedTileIdsRef.current = new Set([node.id]);
              rt.markSeen([node.id]);
              // Selecting promotes the tile to its own compositing layer; snap
              // the viewport so that layer lands on whole pixels (sharp, not
              // blurry). See ViewportSnap.
              bumpSnap();
              if (isNewSelection) {
                // Terminals, diff (Pierre) and editor (CodeMirror) all need
                // EXACTLY 100% zoom when focused. xterm maps the mouse to a cell
                // using the UNSCALED cell size, so a drag-selection at any zoom ≠ 1
                // lands on the wrong row; diff/editor render DOM text the browser
                // only rasterizes crisply at 1:1. Snap all of them to 100% AND
                // frame the tile in one move (exact focus recentres on the tile,
                // anchoring the content corner when it's bigger than the viewport).
                if (
                  node.type === "terminal" ||
                  node.type === "diff" ||
                  node.type === "editor" ||
                  node.type === "workbench"
                ) {
                  focusTile(node.id, { exact: true });
                }
              }
            }
          }}
          onPaneClick={() => {
            selectTile(null);
            rt.selectedTileIdsRef.current = new Set();
          }}
          onSelectionChange={({ nodes: sel }) => {
            // Track which frame (if any) is the user's current single
            // selection. Drives F2-rename + future bulk frame ops. We only
            // care about single-frame selection; multi-select clears.
            if (sel.length === 1 && sel[0]!.type === "frame") {
              commands.selectFrame(sel[0]!.id);
            } else {
              commands.selectFrame(null);
            }
            // Track selected tiles for agent-awareness: selecting a tile counts
            // as "seeing" it, so a done-unseen tile clears + its toast dismisses.
            const tileIds = sel.filter((n) => n.type !== "frame").map((n) => n.id);
            rt.selectedTileIdsRef.current = new Set(tileIds);
            rt.markSeen(tileIds);
          }}
          onNodeDragStop={onNodeDragStop}
          // NEVER cull off-viewport tiles. Culling unmounts a node — harmless
          // for the body now (the TileHost owns it, the slot just parks it), but
          // the node's slot re-adopting on every scroll would refit xterm and
          // flash the tile. Keep every node mounted; the WebGL slot manager
          // already caps GPU contexts on huge boards.
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
          <ViewportMirror target={currentViewportRef} />

          {/* Excalidraw-style floating tool island — top-center. Hidden in zen. */}
          {!zen && (
          <Panel position="top-center" className="!m-0 !mt-3">
            <ToolIsland
              repoPath={repoPath}
              onToggle={(k) => spawnVis(k)}
              agentSel={rt.agentSel}
              onAgentChange={rt.setAgentSel}
              onSpawnAgent={(a) => rt.spawnAgent(a)}
              onFrame={addFrame}
              onBrowser={rt.spawnBrowser}
              onTheme={() => setCustomizerOpen((o) => !o)}
              updateAvailable={rt.updateAvailable}
              onUpgrade={rt.onUpgrade}
              upgrading={rt.upgrading}
            />
          </Panel>
          )}

          {/* Background-event toasts — BOTTOM-right (top-right collides with the
              Board/List/Canvas switcher). An agent that goes blocked or finishes
              while off-screen pings here; click to fly to it. Must stay inside
              <ReactFlow>: a card's focus uses the react-flow camera. */}
          {rt.toasts.length > 0 && (
            <Panel position="bottom-right" className="!m-0 !mr-3 !mb-3">
              <Toasts toasts={rt.toasts} onDismiss={rt.dismissToast} onView={(id) => rt.markSeen([id])} />
            </Panel>
          )}

          {/* Zoom + nav island — bottom-left (Excalidraw footer). The EYE toggle
              is always visible (it restores zen); the zoom island hides in zen. */}
          <Panel position="bottom-left" className="!m-0 !ml-3 !mb-3">
            <div className="flex items-center gap-2 pointer-events-auto">
              <button
                onClick={() => setZen((z) => !z)}
                className="hm-island size-8 grid place-items-center rounded-lg text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
                title={zen ? "Show UI" : "Hide UI (zen mode)"}
                aria-label={zen ? "show UI" : "hide UI"}
              >
                {zen ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              {!zen && (
                <ZoomIsland
                  tileCount={nodes.length}
                  minimapOn={minimapOn}
                  onToggleMinimap={() => setMinimapOn((v) => !v)}
                  onReset={rt.resetCanvas}
                  onFocus={() => {
                    const id = rt.selectedTileIdRef.current ?? rt.selectedFrameIdRef.current;
                    rt.setFocusModeReq({ id, n: ++rt.focusModeNonceRef.current });
                  }}
                />
              )}
            </div>
          </Panel>

          {showMinimap && !zen && (
            <MiniMap
              pannable
              zoomable
              className="!bg-[var(--color-bg3)] !border !border-[var(--color-line2)] !rounded-lg"
              maskColor="rgba(0,0,0,0.55)"
              nodeColor="var(--color-line2)"
            />
          )}
        </ReactFlow>
        {isEmpty && (
          <CanvasEmptyState
            repoPath={repoPath}
            onShowTree={() => spawnVis("tree")}
            onShowShell={() => spawnVis("shell")}
            onShowDiff={() => spawnVis("diff")}
            onSpawnClaude={() => spawnClaude()}
            onInitWorkspace={rt.onInitWorkspace}
          />
        )}
        <ThemeCustomizer open={customizerOpen} onClose={() => setCustomizerOpen(false)} />
        </div>
      </div>
    </PinnedLayerContext.Provider>
  );
}

export const canvasViewPlugin: WorkspaceViewPlugin = {
  id: "canvas",
  label: "Canvas",
  hint: "Infinite board of tiles",
  icon: LayoutGrid,
  component: CanvasView,
};
