/**
 * windows-layout — the Windows view's persisted navigation state: which tiles
 * are minimized out of the tab strip, and the active tab. One person's: kept on
 * this device under the view id `windows`, never in the workspace document, so
 * two windows on one workspace each have their own tab up.
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
  personal: true,
};
