/**
 * View-mode preference + Windows-view helpers.
 *
 *   • nextActiveTab: pure tab-selection rule shared by the Windows view.
 */

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
