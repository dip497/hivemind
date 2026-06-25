/**
 * Pure font-size math for per-tile scaling. Kept React-free (no JSX import) so
 * the unit tests can load it under `tsx --test` without pulling in the renderer.
 *
 * Crispness invariant: terminal text is pixel-perfect ONLY at exactly 100% canvas
 * zoom on a DPR=1 display. "Fit to screen" therefore must NOT zoom — it GROWS the
 * grid by raising the font (bigger cells → more cols/rows) at 100% zoom. These
 * helpers compute that grow target.
 */
export const MIN_FONT = 6;
export const MAX_FONT = 32;

/** Snap to an integer px inside [MIN_FONT, MAX_FONT]. */
export function clampFont(n: number): number {
  if (!Number.isFinite(n)) return MIN_FONT;
  return Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(n)));
}

/**
 * Best font (integer CSS px) for a display, from its logical height + DPR.
 *
 * Targets ~46 text rows of the logical screen height (lineHeight 1.3). On low-DPR
 * displays the grid is the ONLY crispness lever — text is pixel-perfect just at
 * 100% canvas zoom / DPR=1 — so the cell is biased UP for sharper glyphs; HiDPI
 * is already crisp and needs no bias.
 */
export function computeOptimalFont(screenHeightCssPx: number, dpr: number): number {
  const h = Number.isFinite(screenHeightCssPx) && screenHeightCssPx > 0 ? screenHeightCssPx : 1080;
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const TARGET_ROWS = 46;
  const LINE_HEIGHT = 1.3;
  const bias = ratio < 2 ? 1 : 0.85;
  return clampFont((h / (TARGET_ROWS * LINE_HEIGHT)) * bias);
}

/** Best font for the CURRENT screen (browser-only; reads window.screen + DPR). */
export function optimalFontForScreen(): number {
  const h = typeof window !== "undefined" ? window.screen?.height ?? 1080 : 1080;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return computeOptimalFont(h, dpr);
}
