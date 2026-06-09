/**
 * Shared @pierre/diffs CodeView config — the worker-pool wiring + theme vars
 * used by both DiffTile and FileViewerTile so the two viewers stay identical.
 *
 * The worker pool moves syntax highlighting off the main thread (the whole
 * point of the 1.2.0 CodeView migration). `workerFactory` is the Vite-bundled
 * worker from pierre-worker.ts.
 */
import type { CSSProperties } from "react";
import { workerFactory } from "./pierre-worker";

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
  theme: { dark: "pierre-dark", light: "pierre-light" } as const,
  lineDiffType: "char" as const,
  maxLineDiffLength: 2000,
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

/** Pin Pierre's typography + diff colors to hivemind's palette. */
export const PIERRE_CSS_VARS: CSSProperties = {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ...({
    "--diffs-font-family": '"JetBrains Mono", monospace',
    "--diffs-font-size": "13px",
    "--diffs-line-height": "1.6",
    "--diffs-tab-size": "2",
    "--diffs-min-number-column-width": "3ch",
    "--diffs-header-font-family": '"Geist", sans-serif',
    // Diff add/del/modified + selection derive from the theme palette so the
    // diff viewer reads as the same app as everything else. Was hot-orange
    // selection (rgb(255,122,26)) — clashed with the cool-navy identity.
    // ok #22c55e, err #f43f5e, brand #5b6cff.
    "--diffs-deletion-color-override": "rgba(244,63,94,0.14)",
    "--diffs-addition-color-override": "rgba(34,197,94,0.15)",
    "--diffs-modified-color-override": "rgba(91,108,255,0.14)",
    "--diffs-selection-color-override": "rgb(91,108,255)",
    "--diffs-bg-selection-override": "rgba(91,108,255,0.18)",
    "--diffs-bg-selection-number-override": "rgba(91,108,255,0.32)",
    "--diffs-gap-inline": "8px",
    "--diffs-gap-block": "8px",
  } as Record<string, string>),
};
