/**
 * canvas-layout — the canvas view's persisted arrangement state: tile positions
 * + sizes (world coords) and the last viewport. Its own versioned blob
 * (`hivemind:view-layout:canvas:<repo>`), imported ONCE from the pre-v2 core
 * blob where this geometry used to live inline (canvas-persistence.ts).
 *
 * Frame rects (FrameState.x/y/w/h) are still on the core frame record — the
 * runtime's frame auto-fit / spawn placement / worktree hooks read them and must
 * run even while another view is active (a tile spawned in Windows mode needs a
 * canvas slot for when you switch back). Splitting them out is phase 2 in
 * docs/design/workspace-views.md.
 */
import { loadLayout, LAYOUT_VERSION, type PersistedLayout } from "../../canvas-persistence";
import { loadViewLayout, type ViewLayoutSpec } from "../view-layout-store";

export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { width: number; height: number }>;
  viewport?: { x: number; y: number; zoom: number };
}

const fromCore = (core: PersistedLayout): CanvasLayout =>
  ({ positions: core.positions ?? {}, sizes: core.sizes ?? {}, viewport: core.viewport });

export const CANVAS_LAYOUT: ViewLayoutSpec<CanvasLayout> = {
  viewId: "canvas",
  version: 1,
  initial: () => ({ positions: {}, sizes: {}, viewport: undefined }),
  migrate: (_data, from, repoPath) => {
    // No canvas blob yet → this install predates per-view layouts. The core blob
    // (any version) still carries the geometry if it was ever saved inline.
    if (from !== null) return null;
    return fromCore(loadLayout(repoPath));
  },
};

/**
 * Load the canvas geometry. A core blob still at a PRE-v2 version means an
 * older build wrote it more recently than this one did (a v1.16.0 ↔ dev-build
 * round trip on one profile); its inline geometry is then the newer
 * arrangement and wins over the canvas blob. A v2+ build always re-stamps the
 * core blob on its first save, so the override lasts exactly one launch.
 */
export function loadCanvasLayout(repoPath: string | null): CanvasLayout {
  if (repoPath) {
    const core = loadLayout(repoPath);
    if ((core.version ?? 1) < LAYOUT_VERSION && (Object.keys(core.positions ?? {}).length > 0 || core.viewport)) {
      return fromCore(core);
    }
  }
  return loadViewLayout(CANVAS_LAYOUT, repoPath);
}
