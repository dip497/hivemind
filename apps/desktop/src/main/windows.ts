/**
 * The app's windows (docs/design/multiplayer-2026-09-28.md, R5): several may be open, each on a
 * workspace of its own choosing; two on one workspace show the same terminals live. What
 * concerns everyone goes to every window, what concerns the user to the window they are at, and
 * a call is taken from the main frame of any of them (never from a page a tile shows). A browser
 * tab signed in to the browser server hears what every window hears.
 */
import { BrowserWindow } from "electron";
import type { Tab } from "./browser-server.js";

const windows = new Set<BrowserWindow>();
const tabs = new Set<Tab>();
let lastFocused: BrowserWindow | null = null;

/** Count `win` among the app's windows until it closes. */
export function registerWindow(win: BrowserWindow): void {
  windows.add(win);
  lastFocused = win;
  win.on("focus", () => { lastFocused = win; });
  win.on("closed", () => {
    windows.delete(win);
    if (lastFocused === win) lastFocused = null;
  });
}

/** Count `tab` among those told everything until it goes. */
export function registerTab(tab: Tab): void {
  tabs.add(tab);
  tab.once("destroyed", () => tabs.delete(tab));
}

/** A browser tab is open on the app. */
export const tabsOpen = (): boolean => tabs.size > 0;

/** Every app window still open. */
export function openWindows(): BrowserWindow[] {
  return [...windows].filter((w) => !w.isDestroyed());
}

/** Tell every window and every tab. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of openWindows()) {
    try { w.webContents.send(channel, ...args); } catch { /* torn down */ }
  }
  for (const tab of tabs) tab.send(channel, ...args);
}

/** The window the user is at: the focused one, else the one focused last, else any. */
export function userWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && !focused.isDestroyed()) return focused;
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused;
  return openWindows()[0] ?? null;
}

/** The app window whose page `sender` is, or null (a tile's page, a closed window). */
export function appWindowOf(sender: object): BrowserWindow | null {
  return openWindows().find((w) => w.webContents === sender) ?? null;
}
