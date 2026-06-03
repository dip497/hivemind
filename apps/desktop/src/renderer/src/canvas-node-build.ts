/**
 * canvas-node-build — the pure react-flow node-array builder, lifted out of
 * Canvas.tsx's heavy `baseNodes` memo. Given a snapshot of canvas state + the
 * tile/frame callbacks, returns the Node[] (frames first — parents before
 * worktree children — then tiles, with zone-repo scoping + relative nesting +
 * baked zIndex). No React: Canvas calls it inside a useMemo with the same deps.
 */
import type { Node } from "@xyflow/react";
import { identifyAgent } from "./agent-state";
import { defaultSizeForKind } from "./canvas-sizing";
import { defaultShell, type FrameState, type TileInstance } from "./canvas-persistence";
import type { ArrangeMode } from "./frame-layout";
import type { WorktreeEntry } from "../../shared/ipc";

/** Auto-derive a short tile name from the command. Uses identifyAgent for known
 *  agents (claude, codex, gemini, …), falls back to the cmd basename. */
export function autoNameFromCmd(cmd: string): string {
  const agent = identifyAgent(cmd);
  if (agent) return agent;
  return cmd.split("/").pop()?.split(/\s+/)[0] ?? "terminal";
}

export interface NodeBuildCtx {
  repoPath: string | null;
  root: string | null;
  cwd: string;
  tiles: TileInstance[];
  frames: FrameState[];
  frameOf: Record<string, string>;
  sizes: Record<string, { width: number; height: number }>;
  positions: Record<string, { x: number; y: number }>;
  editorTabs: Record<string, string[]>;
  tileNames: Record<string, string>;
  agentTitles: Record<string, string>;
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
  openFileInTile: (tileId: string, file: string) => void;
  closeTabInTile: (tileId: string, file: string) => void;
  closeTile: (id: string) => void;
  onNodeResizeCommit: (id: string, w: number, h: number, x?: number, y?: number) => void;
  renameTile: (id: string, name: string) => void;
  setAgentTitle: (id: string, title: string) => void;
}

export function buildBaseNodes(ctx: NodeBuildCtx): Node[] {
  const {
    repoPath, root, cwd, tiles, frames, frameOf, sizes, positions, editorTabs,
    tileNames, agentTitles, frameTiles, framesChipNames,
    updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, bringFrameToFront,
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace,
    openFileInTile, closeTabInTile, closeTile, onNodeResizeCommit, renameTile, setAgentTitle,
  } = ctx;

  const out: Node[] = [];
  let x = 40;
  const y = 60;
  const gap = 24;

  /** Build a node spec; parenting comes from the EXPLICIT frameOf map (not
   *  geometry). NO extent:'parent' — tiles move freely; membership changes only
   *  on drop (onNodeDragStop). */
  const mkTile = (base: Omit<Node, "position">, ax: number, ay: number): Node => {
    const p = positions[base.id];
    const px = p?.x ?? ax;
    const py = p?.y ?? ay;
    // Bake the baseline tile zIndex (100, above frames) HERE so the selection
    // `nodes` memo's no-selection path can return baseNodes VERBATIM.
    const style = { ...(base.style as Record<string, unknown>), zIndex: 100 };
    const parentFrame = frameOf[base.id] ? frames.find((f) => f.id === frameOf[base.id]) : undefined;
    if (parentFrame) {
      const owner = parentFrame;
      // Zone repo for tiles inside this frame: a worktree (branch zone) wins,
      // else a bound workspace folder, else nothing (keep base repoPath/cwd/root).
      const zoneRepo = owner?.worktreePath ?? owner?.workspacePath;
      // A workspace zone is a DIFFERENT repo bound to the frame. A worktree zone
      // is the SAME repo on another branch (no .hivemind of its own — issues
      // stay the project's, so it keeps the base root).
      const isWorkspaceZone = !owner?.worktreePath && owner?.workspacePath != null;
      const bd = base.data as Record<string, unknown>;
      const data = zoneRepo
        ? {
            ...bd,
            ...("cwd" in bd ? { cwd: zoneRepo } : {}),
            ...("repoPath" in bd ? { repoPath: zoneRepo } : {}),
            // Issues/diff/tree scope by `root` (.hivemind). For a workspace zone,
            // point them at THAT repo's root. CRITICAL: never fall through to the
            // canvas base root here (that leaked the launch repo's issues board
            // into an unrelated frame — the cross-repo leak bug).
            ...("root" in bd && isWorkspaceZone ? { root: owner?.workspaceRoot ?? null } : {}),
          }
        : base.data;
      return {
        ...base,
        style,
        data,
        position: { x: px - parentFrame.x, y: py - parentFrame.y },
        parentId: parentFrame.id,
      };
    }
    return { ...base, style, position: { x: px, y: py } };
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

  // Every tile is an instance. editor/diff/issues need a repo — skip them if the
  // active repo went away. Each kind maps to its node type + default size + data.
  for (const t of tiles) {
    if ((t.kind === "editor" || t.kind === "diff") && !repoPath) continue;
    let node: Omit<Node, "position">;
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
      // claude / shell — both render as a TerminalTile.
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
          name: tileNames[t.id] ?? agentTitles[t.id] ?? autoNameFromCmd(cmd),
          onRename: renameTile,
          onAgentTitle: setAgentTitle,
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
}
