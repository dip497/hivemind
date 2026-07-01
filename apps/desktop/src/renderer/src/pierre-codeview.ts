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
    "--diffs-addition-color-override": "var(--color-ok)",    /* green-700  — added lines   */
    "--diffs-deletion-color-override": "var(--color-err)",   /* red-500    — removed lines */
    "--diffs-modified-color-override": "var(--color-brand)", /* lavender   — modified / change icon */

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
