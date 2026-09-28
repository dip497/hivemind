/**
 * windows-layout — the Windows view's persisted navigation state: which tiles
 * are minimized out of the tab strip, and the active tab. Versioned per-repo
 * blob in the workspace store, under the view id `windows`.
 */
import type { ViewLayoutSpec } from "../view-layout-store";

export interface WindowsLayout {
  minimized: string[];
  activeTabId: string | null;
}

export const WINDOWS_LAYOUT: ViewLayoutSpec<WindowsLayout> = {
  viewId: "windows",
  version: 1,
  initial: () => ({ minimized: [], activeTabId: null }),
};
