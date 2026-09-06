/**
 * View-mode preference + Windows-view helpers.
 *
 *   • viewMode: the active view plugin's id — GLOBAL (a UI preference, not
 *     per-repo), so switching projects keeps you in the view you chose. Stored
 *     raw; the runtime maps it through `resolveViewId` (workspace-view.ts) so an
 *     id whose plugin is gone falls back instead of breaking the app.
 *   • minimizedTabs: LEGACY per-repo key (pre view-plugins). The Windows view now
 *     keeps this in its own versioned layout blob (workspace/views/windows-
 *     layout.ts) and imports the old key once; kept for that migration + tests.
 *   • nextActiveTab: pure tab-selection rule shared by the Windows view.
 */

const VIEW_MODE_KEY = "hivemind:view-mode";

/** The stored view id (unvalidated) — null when unset. */
export function loadViewMode(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(VIEW_MODE_KEY); } catch { return null; }
}

export function saveViewMode(viewId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, viewId);
  } catch {
    /* private mode / quota — best-effort */
  }
}

/** Per-repo key for the LEGACY minimized-tab set (migration source). */
export const MINIMIZED_KEY = (repoPath: string | null): string =>
  `hivemind:windows-minimized:${repoPath ?? "__global__"}`;

export function loadMinimized(repoPath: string | null): Set<string> {
  if (typeof window === "undefined" || !repoPath) return new Set();
  try {
    const raw = window.localStorage.getItem(MINIMIZED_KEY(repoPath));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function saveMinimized(repoPath: string | null, ids: Set<string>): void {
  if (typeof window === "undefined" || !repoPath) return;
  try {
    window.localStorage.setItem(MINIMIZED_KEY(repoPath), JSON.stringify([...ids]));
  } catch {
    /* best-effort */
  }
}

/**
 * Pick the tab that should be active after the open/minimized sets change.
 * Pure so it's unit-testable (used by the Windows view). Rules:
 *   • keep the current active tab if it's still an OPEN, non-minimized tile;
 *   • otherwise fall back to the first visible tab in `order`;
 *   • null when nothing is visible.
 * `order` is the tab id list already filtered to what's shown in the strip.
 */
export function nextActiveTab(
  current: string | null,
  order: readonly string[],
): string | null {
  if (current && order.includes(current)) return current;
  return order[0] ?? null;
}
