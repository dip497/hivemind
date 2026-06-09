import type { Terminal } from "@xterm/xterm";

/**
 * Terminal device-pixel-ratio policy.
 *
 * HISTORY / WHY THIS IS A NO-OP NOW: an earlier version monkeypatched xterm's
 * internal `_coreBrowserService.dpr` to a SUPERSAMPLE FLOOR of 2, trying to make
 * WebGL glyphs crisp on DPR=1 displays. That corrupts xterm's geometry and is the
 * bug behind "terminal text doesn't wrap / clips at the right edge":
 *
 *   - FitAddon computes cols from `dimensions.css.cell.width`.
 *   - `css.cell.width = device.cell.width / dpr`, and
 *     `device.cell.width = round(cssCharWidth × dpr)`.
 *   - The browser composites the canvas's CSS pixels at the REAL
 *     window.devicePixelRatio, but with the patched dpr xterm sizes the canvas
 *     using a DIFFERENT dpr → the WebGL canvas ends up wider than its container →
 *     horizontal overflow, and the cols the PTY is told no longer match the
 *     visible width → claude/TUIs render lines that clip instead of wrap.
 *     (Confirmed against xterm.js internals: device/css cell dims are both
 *     derived through `_devicePixelRatio`; faking it desyncs them.)
 *
 * You cannot fake your way to retina sharpness on a true DPR=1 panel via the DPR
 * value — it breaks the cell math. opencove's controller (which inspired the
 * original patch) actually returns the REAL `window.devicePixelRatio`; it only
 * re-rasterizes when you move the window between monitors. It was never a
 * supersampler. Real crispness levers on DPR=1: a larger font (more real device
 * pixels per glyph — the per-tile A−/A+ control) or OS display scaling (set the
 * desktop to 125–150% so the real DPR rises, like a HiDPI panel).
 *
 * So we leave xterm's own DPR handling (ScreenDprMonitor) untouched and use the
 * display's real ratio everywhere. `effectiveDpr` exists only so the diagnostics
 * HUD can show what the renderer rasterizes at.
 */

/** The DPR the renderer rasterizes glyphs at: the display's real ratio. */
export function effectiveDpr(baseDpr: number): number {
  return Number.isFinite(baseDpr) && baseDpr > 0 ? baseDpr : 1;
}

/**
 * No-op. Kept as a named export so call sites need no change. We intentionally
 * do NOT override xterm's internal dpr (see the module doc above — doing so
 * desyncs cell geometry and clips terminal text). Returns a noop disposer.
 */
export function installCrispDpr(_terminal: Terminal): () => void {
  return () => {};
}
