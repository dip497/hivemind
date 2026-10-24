/**
 * Shared @pierre/diffs config — the worker-pool wiring and the theme used by every diff the app
 * draws: the Diff tile (which the Code Workbench embeds), its one-file view
 * (code/DiffSurface.tsx), a conflicted file (code/ConflictView.tsx) and the PatchView tools draw
 * with (tiles/host-sdk.tsx), so they stay identical. Its type and colours are one rule on Pierre's
 * host element, wherever it mounts (styles.css, `diffs-container`).
 *
 * The worker pool moves syntax highlighting off the main thread (the whole
 * point of the 1.2.0 CodeView migration). `workerFactory` is the Vite-bundled
 * worker from pierre-worker.ts.
 */
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
  foreground: "var(--color-diff-text)",
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
const PIERRE_THEME = { dark: THEME, light: THEME } as const;

/** What every diff surface passes Pierre: the theme, and CSS Pierre puts in each shadow root's last
 *  layer. `--diffs-bg-deletion-override` (styles.css) is both a removed row's tint and, in
 *  Pierre, the dark stripe of a removed line's hatched bar (`--diffs-bg-deletion`), which then sat
 *  near its bright one (1.5:1 in Clean Light) and the bar read as solid, like an added line's. The
 *  stripe goes back to Pierre's own: the page with a fifth (an eighth, light) of the removed colour.
 *  A constant, so Pierre sees the same options on every render. */
export const PIERRE_OPTIONS = {
  theme: PIERRE_THEME,
  unsafeCSS: ":host{--diffs-bg-deletion:light-dark(color-mix(in lab,var(--diffs-bg) 88%,var(--diffs-deletion-base)),color-mix(in lab,var(--diffs-bg) 80%,var(--diffs-deletion-base)))}",
} as const;

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
