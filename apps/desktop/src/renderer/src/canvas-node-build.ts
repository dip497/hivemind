/**
 * canvas-node-build — the pure react-flow node-array builder for the CANVAS
 * view. Given the workspace model + canvas geometry, returns the Node[] (frames
 * first — parents before worktree children — then tiles, with relative nesting +
 * baked zIndex). Tile nodes carry SHELL data only (`CanvasTileNodeData`: id,
 * resize, pin, close) — the body and its repo scoping are the tile surface's
 * (workspace/tile-surfaces.ts), rendered by the shared TileHost into the node's
 * `<TileSlot>`. No React: CanvasView calls it inside a useMemo.
 */
import type { Node } from "@xyflow/react";
import { defaultSizeForKind } from "./canvas-sizing";
import type { FrameState, TileInstance } from "./canvas-persistence";
import type { ArrangeMode } from "./frame-layout";
import type { WorktreeEntry } from "../../shared/ipc";
import { effectiveRepoOf, type PinRect, type TileSurfaceType } from "./workspace/tile-surfaces";
import type { CanvasTileNodeData } from "./canvas-nodes";

export interface NodeBuildCtx {
  repoPath: string | null;
  tiles: TileInstance[];
  frames: FrameState[];
  frameOf: Record<string, string>;
  /** Tile ids currently pinned (float above + viewport-fixed). */
  pinnedIds: Set<string>;
  sizes: Record<string, { width: number; height: number }>;
  positions: Record<string, { x: number; y: number }>;
  frameTiles: Map<string, string[]>;
  framesChipNames: Record<string, string>;
  updateFrameTitle: (id: string, title: string) => void;
  updateFrameColor: (id: string, color: string) => void;
  deleteFrame: (id: string) => void;
  arrangeFrame: (id: string, mode: ArrangeMode) => void;
  bringFrameToFront: (id: string) => void;
  onAttachWorktree: (frameId: string, entry: WorktreeEntry) => void;
  onCreateWorktree: (frameId: string, branch: string) => void;
  unbindBranch: (id: string) => void;
  bindWorkspace: (id: string) => void;
  unbindWorkspace: (id: string) => void;
  closeTile: (id: string) => void;
  onNodeResizeCommit: (id: string, w: number, h: number, x?: number, y?: number) => void;
  /** Toggle a tile's pinned state. `rect` is the tile's SCREEN rect (top-left +
   *  size) captured from its DOM at click time (ignored when unpinning). */
  onTogglePin: (id: string, rect: PinRect) => void;
  /** Persist a pinned panel's new anchor and/or size after a drag/resize. */
  onPinChange: (id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => void;
}

/** react-flow node type per tile kind — doubles as the `.react-flow__node-<type>`
 *  CSS hook and matches the surface `type` the TileHost renders. */
const NODE_TYPE: Record<TileInstance["kind"], TileSurfaceType> = {
  claude: "terminal", shell: "terminal", editor: "workbench", workbench: "workbench",
  diff: "diff", issues: "issues", browser: "browser", planReview: "planReview",
};

export function buildBaseNodes(ctx: NodeBuildCtx): Node[] {
  const {
    repoPath, tiles, frames, frameOf, pinnedIds, sizes, positions, frameTiles, framesChipNames,
    updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, bringFrameToFront,
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace,
    closeTile, onNodeResizeCommit, onTogglePin, onPinChange,
  } = ctx;

  const out: Node[] = [];
  let x = 40;
  const y = 60;
  const gap = 24;

  /** Build a node spec; parenting comes from the EXPLICIT frameOf map (not
   *  geometry). NO extent:'parent' — tiles move freely; membership changes only
   *  on drop (onNodeDragStop). The tile's repo/cwd scoping is NOT here any more
   *  — the surface builder applies the zone-repo override to the body data. */
  const mkTile = (base: Omit<Node, "position">, ax: number, ay: number): Node => {
    const p = positions[base.id];
    const px = p?.x ?? ax;
    const py = p?.y ?? ay;
    // Bake the baseline tile zIndex (100, above frames) HERE so the selection
    // `nodes` memo's no-selection path can return baseNodes VERBATIM.
    const style = { ...(base.style as Record<string, unknown>), zIndex: 100 };
    // Pin controls live on EVERY tile's data (rendered by the node wrapper as a
    // corner badge; the floating panel when pinned). `onTogglePin`/`onPinChange`
    // are stable (useCallback); the wrapper supplies the id, so no per-build
    // closure churns React.memo. Anchor/size come from the persisted
    // TileInstance so a pinned panel restores at its saved screen spot + size.
    const pinTile = tiles.find((t) => t.id === base.id);
    const pinData = {
      pinned: pinnedIds.has(base.id),
      pinAnchor: pinTile?.pinAnchor,
      pinSize: pinTile?.pinSize,
      onTogglePin,
      onPinChange,
      // Every tile with its own header docks the pin button there (next to close),
      // so the shell/panel must not also draw the floating chip. planReview is
      // ephemeral (never pinned); frames aren't tiles — both excluded.
      headerPin: pinTile ? pinTile.kind !== "planReview" : false,
    };
    const data = { ...(base.data as Record<string, unknown>), ...pinData };
    const parentFrame = frameOf[base.id] ? frames.find((f) => f.id === frameOf[base.id]) : undefined;
    if (parentFrame) {
      return {
        ...base,
        style,
        data,
        position: { x: px - parentFrame.x, y: py - parentFrame.y },
        parentId: parentFrame.id,
      };
    }
    return { ...base, style, data, position: { x: px, y: py } };
  };

  // Clamp the default to the visible viewport so a wide tile spawns grabbable.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
  const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
  const sized = (id: string, w: number, h: number) => {
    const s = sizes[id];
    if (s) return { width: s.width, height: s.height };
    return { width: Math.min(w, Math.max(640, vw - 80)), height: Math.min(h, Math.max(420, vh - 120)) };
  };

  // Frames FIRST, PARENTS before their worktree CHILD frames (react-flow needs a
  // parent node emitted before any node referencing it via parentId).
  const frameById = new Map(frames.map((f) => [f.id, f]));
  const orderedFrames = [
    ...frames.filter((f) => !f.parentFrameId || !frameById.has(f.parentFrameId)),
    ...frames.filter((f) => f.parentFrameId && frameById.has(f.parentFrameId)),
  ];
  for (const f of orderedFrames) {
    const parent = f.parentFrameId ? frameById.get(f.parentFrameId) : undefined;
    // Child frame nests inside its parent: position RELATIVE to the parent.
    // zIndex tiers: parent repo frame (≤40) < worktree child frame (50–90) <
    // tiles (≥100) < selected (1000).
    const position = parent ? { x: f.x - parent.x, y: f.y - parent.y } : { x: f.x, y: f.y };
    const zIndex = parent ? 50 + Math.min(f.z, 40) : Math.min(f.z, 40);
    out.push({
      id: f.id,
      type: "frame",
      position,
      ...(parent ? { parentId: parent.id } : {}),
      style: { width: f.w, height: f.h, zIndex },
      data: {
        id: f.id,
        title: f.title,
        color: f.color,
        branch: f.branch,
        worktreePath: f.worktreePath,
        head: f.head,
        parentFrameId: f.parentFrameId,
        repoPath: f.workspacePath ?? repoPath ?? undefined,
        workspacePath: f.workspacePath,
        workspaceRoot: f.workspaceRoot,
        canBind: !!repoPath,
        onTitleChange: updateFrameTitle,
        onColorChange: updateFrameColor,
        onDelete: deleteFrame,
        onArrange: arrangeFrame,
        onBringToFront: bringFrameToFront,
        onAttachWorktree,
        onCreateWorktree,
        onUnbindBranch: unbindBranch,
        onBindWorkspace: bindWorkspace,
        onUnbindWorkspace: unbindWorkspace,
        tileIds: frameTiles.get(f.id) ?? [],
        tileNames: framesChipNames,
      },
      dragHandle: ".tile-drag-handle",
    });
  }

  // Every tile is an instance. editor/diff need a repo — skip them only if NO
  // repo is available (global or the owner frame's zone). Same gate as the
  // surface builder, so a node never exists without a body.
  for (const t of tiles) {
    if ((t.kind === "editor" || t.kind === "diff") && !effectiveRepoOf(t.id, frameOf, frames, repoPath)) continue;
    const { width: w, height: h } = defaultSizeForKind(t.kind);
    const data: CanvasTileNodeData = { tileId: t.id, onClose: () => closeTile(t.id), onResize: onNodeResizeCommit };
    out.push(mkTile({ id: t.id, type: NODE_TYPE[t.kind], style: sized(t.id, w, h), data, dragHandle: ".tile-drag-handle" }, x, y));
    x += (sizes[t.id]?.width ?? w) + gap;
  }
  return out;
}
