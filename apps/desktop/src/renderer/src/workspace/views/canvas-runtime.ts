/**
 * canvas-runtime — the canvas plugin's private line to the runtime-hosted
 * geometry + gesture handlers. MILESTONE-1 SEAM, documented debt.
 *
 * Why the canvas view alone gets this: tile positions/sizes, the viewport and
 * frame rects are the canvas's arrangement state, but the hooks that MUTATE them
 * (useSpawn's in-frame placement, useFrameOps' auto-fit + arrange, useWorktrees'
 * frame creation, useNodeDragStop) also perform core work and must keep running
 * while another view is active — a tile spawned from Windows mode needs a
 * canvas slot for when you switch back. So Workspace.tsx keeps that state and
 * exposes it here; CanvasView reads it via `useCanvasRuntime()`. No other view
 * may import this module. Phase 2 (docs/design/workspace-views.md) moves the
 * placement logic into a headless per-plugin layout engine and deletes it.
 */
import { createContext, useContext, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import type { WorktreeEntry } from "../../../../shared/ipc";
import type { ArrangeMode } from "../../frame-layout";
import type { PinRect } from "../tile-surfaces";
import type { Toast } from "../../useAgentAwareness";

export type Viewport = { x: number; y: number; zoom: number };
export type FocusReq = { id: string; cx: number; cy: number; w: number; h: number; n: number; exact?: boolean } | null;
export type FocusModeReq = { id: string | null; n: number } | null;

export interface CanvasRuntime {
  // ── geometry (persisted by the runtime in the canvas view's layout blob) ──
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { width: number; height: number }>;
  /** The live viewport (updated every pan tick). CanvasView reads it as
   *  react-flow's `defaultViewport` on mount, so a remount (view round trip,
   *  crash fallback, Retry) resumes where the camera WAS — not at app start. */
  currentViewportRef: MutableRefObject<Viewport>;
  /** Commit the post-pan viewport so the layout blob persists it. */
  setViewport: (vp: Viewport) => void;
  onNodeResizeCommit: (id: string, w: number, h: number, x?: number, y?: number) => void;
  handleNodeDragStop: (e: unknown, node: Node) => void;
  /** Wipe this repo's canvas: tiles, frames, geometry (ZoomIsland reset). */
  resetCanvas: () => void;
  // ── camera requests (set by runtime commands, consumed by the camera children) ──
  focusReq: FocusReq;
  focusModeReq: FocusModeReq;
  setFocusModeReq: Dispatch<SetStateAction<FocusModeReq>>;
  focusModeNonceRef: MutableRefObject<number>;
  selectedTileIdRef: MutableRefObject<string | null>;
  selectedFrameIdRef: MutableRefObject<string | null>;
  /** Agent-awareness "seen" tracking (selecting a tile clears its done-unseen). */
  selectedTileIdsRef: MutableRefObject<Set<string>>;
  markSeen: (ids: string[]) => void;
  /** Agent-awareness toasts. Rendered by the canvas: a toast card flies the
   *  react-flow camera to its tile (useTileFocus → useReactFlow), so it can only
   *  live inside <ReactFlow>. */
  toasts: Toast[];
  dismissToast: (id: string) => void;
  // ── frame / worktree ops for FrameNode headers ──
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
  // ── pins ──
  pinnedIds: Set<string>;
  togglePin: (id: string, rect: PinRect) => void;
  onPinChange: (id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => void;
  // ── tool island ──
  agentSel: string;
  setAgentSel: (id: string) => void;
  spawnAgent: (a: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  spawnBrowser: () => void;
  onInitWorkspace?: () => void;
  updateAvailable: boolean;
  onUpgrade: () => void;
  upgrading: boolean;
}

export const CanvasRuntimeContext = createContext<CanvasRuntime | null>(null);

export function useCanvasRuntime(): CanvasRuntime {
  const rt = useContext(CanvasRuntimeContext);
  if (!rt) throw new Error("CanvasView rendered outside the workspace runtime (no CanvasRuntimeContext)");
  return rt;
}
