/**
 * Windowed-view state — persistence + pure helpers for the "editor-like" view
 * mode (a single frame-colored tab strip + one active tile body, driven by the
 * graph rail on the left). Kept out of Canvas.tsx so the load/save shapes are
 * isolated and unit-testable (mirrors canvas-persistence.ts's split).
 *
 * Two pieces of state:
 *   • viewMode: "canvas" | "windows" — GLOBAL (a UI preference, not per-repo),
 *     so switching projects keeps you in the mode you chose. localStorage.
 *   • minimizedTabs: which tiles are hidden from the tab strip but still live in
 *     the graph rail — PER-REPO (a minimized tile is a property of that repo's
 *     canvas), keyed by the same repoPath the layout blob uses.
 */

export type ViewMode = "canvas" | "windows";

const VIEW_MODE_KEY = "hivemind:view-mode";

export function loadViewMode(): ViewMode {
  if (typeof window === "undefined") return "canvas";
  return window.localStorage.getItem(VIEW_MODE_KEY) === "windows" ? "windows" : "canvas";
}

export function saveViewMode(mode: ViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    /* private mode / quota — best-effort */
  }
}

/** Per-repo key for the minimized-tab set. Mirrors LAYOUT_KEY's sentinel so a
 *  no-repo (welcome/e2e) session doesn't leak a minimized set across projects. */
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
 * Pure so it's unit-testable and reused by Canvas + WindowsView. Rules:
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
