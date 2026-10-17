/**
 * canvas-layout — the canvas view's persisted arrangement: tile positions and
 * sizes (world coords), the workspace's, under the view id `canvas`; and the
 * camera, one person's, kept on this device under `canvas-camera`.
 *
 * Frame rects (FrameState.x/y/w/h) are still on the core frame record — the
 * runtime's frame auto-fit / spawn placement / worktree hooks read them and must
 * run even while another view is active (a tile spawned in Windows mode needs a
 * canvas slot for when you switch back). Splitting them out is phase 2 in
 * docs/design/workspace-views.md.
 */
import { rebaseFields } from "@hivemind/workspace-doc/rebase";
import type { ViewLayout } from "@hivemind/workspace-doc/shapes";
import { loadViewLayout, type ViewLayoutSpec } from "../view-layout-store";
import { rereadView } from "../workspace-store-client";
import type { Viewport } from "./canvas-runtime";

type Places = Record<string, { x: number; y: number }>;
type Sizes = Record<string, { width: number; height: number }>;

export interface CanvasLayout {
  positions: Places;
  sizes: Sizes;
  /** Where the camera was, from before it became one person's (R5): read once, to start from. */
  viewport?: Viewport;
}

export const CANVAS_LAYOUT: ViewLayoutSpec<CanvasLayout> = {
  viewId: "canvas",
  version: 1,
  initial: () => ({ positions: {}, sizes: {} }),
};

/** Where this person's camera is on the canvas. */
export const CANVAS_CAMERA: ViewLayoutSpec<Viewport | null> = {
  viewId: "canvas-camera",
  version: 1,
  initial: () => null,
  personal: true,
};

/** Load the canvas geometry. */
export function loadCanvasLayout(repoPath: string | null): CanvasLayout {
  return loadViewLayout(CANVAS_LAYOUT, repoPath);
}

/** Where this person's camera was, or null: this device's, else the one the canvas layout held. */
export function loadCanvasCamera(repoPath: string | null): Viewport | null {
  return loadViewLayout(CANVAS_CAMERA, repoPath) ?? loadCanvasLayout(repoPath).viewport ?? null;
}

/**
 * Another writer changed `repoPath`'s canvas places: read them again, each part as an update of
 * the window's own, which takes the places as stored and keeps what the window changed since it
 * last read or wrote (as `reloadLayout` does the core). Write what is pending first.
 */
export function reloadCanvasLayout(repoPath: string): { positions: (mine: Places) => Places; sizes: (mine: Sizes) => Sizes } {
  const { base, view } = rereadView(repoPath, CANVAS_LAYOUT.viewId);
  const was = placesOf(base);
  const now = placesOf(view);
  return {
    positions: (mine) => rebaseFields(was.positions, mine, now.positions),
    sizes: (mine) => rebaseFields(was.sizes, mine, now.sizes),
  };
}

/** A stored canvas layout's places, or none: another version, or none stored. */
function placesOf(layout: ViewLayout | null): { positions: Places; sizes: Sizes } {
  const data = layout?.v === CANVAS_LAYOUT.version && typeof layout.data === "object" && layout.data !== null ? (layout.data as Partial<CanvasLayout>) : {};
  return { positions: data.positions ?? {}, sizes: data.sizes ?? {} };
}
