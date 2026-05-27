/**
 * Vite-bundled worker factory for @pierre/diffs.
 *
 * Pierre's worker pool needs a factory function that produces a Web Worker.
 * Vite's `?worker` import compiles the target file as a separate Worker
 * bundle and gives us a constructor.
 */
// Vite's `?worker` query is a virtual import handled at build time.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - virtual module
import PierreWorker from "@pierre/diffs/worker/worker.js?worker";

export const workerFactory = (): Worker => new PierreWorker();
