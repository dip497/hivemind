/**
 * The app's windows (docs/design/multiplayer-2026-09-28.md, R5): several may be open, each on a
 * workspace of its own choosing; two on one workspace show the same terminals live. What
 * concerns everyone goes to every window, what concerns the user to the window they are at, and
 * a call is taken from the main frame of any of them (never from a page a tile shows).
 */
import { BrowserWindow, type WebContents } from "electron";

const windows = new Set<BrowserWindow>();
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

/** Every app window still open. */
export function openWindows(): BrowserWindow[] {
  return [...windows].filter((w) => !w.isDestroyed());
}

/** Tell every window. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of openWindows()) {
    try { w.webContents.send(channel, ...args); } catch { /* torn down */ }
  }
}

/** The window the user is at: the focused one, else the one focused last, else any. */
export function userWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && !focused.isDestroyed()) return focused;
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused;
  return openWindows()[0] ?? null;
}

/** The app window whose page `sender` is, or null (a tile's page, a closed window). */
export function appWindowOf(sender: WebContents): BrowserWindow | null {
  return openWindows().find((w) => w.webContents === sender) ?? null;
}
