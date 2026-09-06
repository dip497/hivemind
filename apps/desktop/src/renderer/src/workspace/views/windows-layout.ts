/**
 * windows-layout — the Windows view's persisted navigation state: which tiles
 * are minimized out of the tab strip, and the active tab. Versioned per-repo
 * blob (`hivemind:view-layout:windows:<repo>`); imports the pre-plugin
 * `hivemind:windows-minimized:<repo>` array once.
 */
import { loadMinimized } from "../../windows-view-state";
import type { ViewLayoutSpec } from "../view-layout-store";

export interface WindowsLayout {
  minimized: string[];
  activeTabId: string | null;
}

export const WINDOWS_LAYOUT: ViewLayoutSpec<WindowsLayout> = {
  viewId: "windows",
  version: 1,
  initial: () => ({ minimized: [], activeTabId: null }),
  migrate: (_data, from, repoPath) =>
    from === null ? { minimized: [...loadMinimized(repoPath)], activeTabId: null } : null,
};
