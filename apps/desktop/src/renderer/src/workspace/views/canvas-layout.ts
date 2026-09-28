/**
 * canvas-layout — the canvas view's persisted arrangement state: tile positions
 * + sizes (world coords) and the last viewport. Its own versioned blob in the
 * workspace store, under the view id `canvas`.
 *
 * Frame rects (FrameState.x/y/w/h) are still on the core frame record — the
 * runtime's frame auto-fit / spawn placement / worktree hooks read them and must
 * run even while another view is active (a tile spawned in Windows mode needs a
 * canvas slot for when you switch back). Splitting them out is phase 2 in
 * docs/design/workspace-views.md.
 */
import { loadViewLayout, type ViewLayoutSpec } from "../view-layout-store";

export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { width: number; height: number }>;
  viewport?: { x: number; y: number; zoom: number };
}

export const CANVAS_LAYOUT: ViewLayoutSpec<CanvasLayout> = {
  viewId: "canvas",
  version: 1,
  initial: () => ({ positions: {}, sizes: {}, viewport: undefined }),
};

/** Load the canvas geometry. */
export function loadCanvasLayout(repoPath: string | null): CanvasLayout {
  return loadViewLayout(CANVAS_LAYOUT, repoPath);
}
