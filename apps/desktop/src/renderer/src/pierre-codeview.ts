/**
 * Shared @pierre/diffs config — the worker-pool wiring, the theme and the theme vars used by every
 * diff the app draws: the Diff tile (which the Code Workbench embeds), its one-file view
 * (code/DiffSurface.tsx), a conflicted file (code/ConflictView.tsx) and the PatchView tools draw
 * with (tiles/host-sdk.tsx), so they stay identical.
 *
 * The worker pool moves syntax highlighting off the main thread (the whole
 * point of the 1.2.0 CodeView migration). `workerFactory` is the Vite-bundled
 * worker from pierre-worker.ts.
 */
import type { CSSProperties } from "react";
import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { workerFactory } from "./pierre-worker";

/** The diff's theme: the app's tokens as CSS variables, so its page is the preset's bg2 and its
 *  code the preset's syntax colours, in either mode and through any theme, with no re-highlight on
 *  a change (styles.css redraws the tokens; Pierre's own themes carry a page of their own, #0a0a0a or
 *  white). Pierre writes each as `var(--diffs-<name>, <token>)` on its shadow root's host, so
 *  `--diffs-background` set outside (glass, styles.css) wins. Registered once, at import; the main
 *  thread resolves it and hands it to the workers. Pierre's theme for a mode is this one in both. */
const THEME = "hivemind";
registerCustomCSSVariableTheme(THEME, {
  foreground: "var(--color-fg)",
  background: "var(--color-bg2)",
  "token-keyword": "var(--color-syntax-keyword)",
  "token-string": "var(--color-syntax-string)",
  "token-string-expression": "var(--color-syntax-string)",
  "token-constant": "var(--color-syntax-number)",
  "token-function": "var(--color-syntax-function)",
  "token-parameter": "var(--color-syntax-property)",
  "token-punctuation": "var(--color-fg)",
  "token-comment": "var(--color-syntax-comment)",
  "token-link": "var(--color-syntax-function)",
  "token-inserted": "var(--color-diff-added)",
  "token-deleted": "var(--color-diff-removed)",
  "token-changed": "var(--color-syntax-function)",
  "ansi-green": "var(--color-diff-added)",
  "ansi-red": "var(--color-diff-removed)",
  "ansi-blue": "var(--color-brand)",
});
export const PIERRE_THEME = { dark: THEME, light: THEME } as const;

/** Cap workers at 3 — more threads is diminishing returns and each worker
 *  holds its own shiki highlighter (memory). Mirrors codiff's cap. */
const POOL_SIZE = Math.min(3, Math.max(1, navigator.hardwareConcurrency || 3));

export const workerPoolOptions = {
  workerFactory,
  poolSize: POOL_SIZE,
};

/** Highlighter init for the worker threads. `char`-level intra-line diff is
 *  finer than `word`; maxLineDiffLength bypasses the algorithm on huge lines. */
export const workerHighlighterOptions = {
  theme: PIERRE_THEME,
  lineDiffType: "char" as const,
  maxLineDiffLength: 2000,
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

/** Pin Pierre's typography + diff colors to hivemind's palette. */
export const PIERRE_CSS_VARS: CSSProperties = {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ...({
    "--diffs-font-family": "var(--font-mono)",
    "--diffs-font-size": "var(--text-body)",
    "--diffs-line-height": "1.6",
    "--diffs-tab-size": "2",
    "--diffs-min-number-column-width": "3ch",
    "--diffs-header-font-family": "var(--font-sans)",

    // ── Diff change colors ───────────────────────────────────────────────
    // These `*-color-override` vars feed Pierre's `--diffs-*-base`, which is a
    // SOLID color used directly for: the header +N / −N counts, the classic
    // +/- gutter markers, the `bars` indicator, and the inline word-diff span
    // (Pierre adds its own alpha on top via `rgb(from <base> r g b / .2)`).
    // Pierre then DERIVES the translucent row backgrounds from this same base
    // with `color-mix(in lab, var(--diffs-bg) 80%, <base>)`. So the override
    // MUST be solid — the old rgba(...,0.14) values made the counts, markers
    // and word highlights nearly invisible and washed out the row tint.
    // Bound to the oklch semantic tokens so the diff stays in sync when the
    // accent is recolored, and reads as the same product as the rest of the app.
    // The counts are text on the preset's bg2, so added and removed are the
    // palette's ok and err lifted to read there (styles.css).
    "--diffs-addition-color-override": "var(--color-diff-added)",   /* ok  — added lines   */
    "--diffs-deletion-color-override": "var(--color-diff-removed)", /* err — removed lines */
    "--diffs-modified-color-override": "var(--color-brand)", /* lavender   — modified / change icon */

    // ── Changed rows ─────────────────────────────────────────────────────
    // A row mixes its page with a tint (20% dark, 12% light) and a changed word
    // lays a translucent one over that. Pierre mixes in the solid colours above,
    // so Dracula's bright green lit a row past what syntax reads on; each tint
    // here is ok, err or brand at one lightness (styles.css), the same for a
    // row, its line number and a conflict's side.
    "--diffs-bg-addition-override": "var(--color-diff-added-tint)",
    "--diffs-bg-addition-number-override": "var(--color-diff-added-tint)",
    "--diffs-bg-deletion-override": "var(--color-diff-removed-tint)",
    "--diffs-bg-deletion-number-override": "var(--color-diff-removed-tint)",
    "--diffs-bg-addition-emphasis-override": "var(--color-diff-added-word)",
    "--diffs-bg-deletion-emphasis-override": "var(--color-diff-removed-word)",
    "--conflict-bg-current-override": "var(--color-diff-added-tint)",
    "--conflict-bg-current-number-override": "var(--color-diff-added-tint)",
    "--conflict-bg-current-header-override": "var(--color-diff-added-tint)",
    "--conflict-bg-incoming-override": "var(--color-diff-changed-tint)",
    "--conflict-bg-incoming-number-override": "var(--color-diff-changed-tint)",
    "--conflict-bg-incoming-header-override": "var(--color-diff-changed-tint)",

    // Selection highlight for enableLineSelection. `--diffs-selection-base`
    // is hardwired to the modified base, so a selected line already tints
    // brand; we only strengthen the number-column gutter a touch. (The lib's
    // `--diffs-selection-color-override` hook is documented but unconsumed —
    // no CSS rule reads it — so it's intentionally omitted.)
    "--diffs-bg-selection-override": "color-mix(in srgb, var(--color-brand) 22%, transparent)",
    "--diffs-bg-selection-number-override": "color-mix(in srgb, var(--color-brand) 34%, transparent)",

    "--diffs-gap-inline": "8px",
    "--diffs-gap-block": "8px",
  } as Record<string, string>),
};
