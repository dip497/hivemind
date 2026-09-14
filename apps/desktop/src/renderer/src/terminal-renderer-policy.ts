/** DOM is sharper below 2x DPR; WebGL is cheaper for a tile streaming off to the side.
 *  Selected-tile-on-WebGL measured slower (docs/design/perf-streaming-2026-09-11.md). */

export const STREAM_QUIET_MS = 1500;

export interface RendererInputs {
  dpr: number;
  now: number;
  lastStreamTs: number;
  selected: boolean;
  /** After a lost WebGL context, re-acquiring just loses it again. */
  webglCooldownUntil: number;
}

export function wantsDomRenderer({ dpr, now, lastStreamTs, selected, webglCooldownUntil }: RendererInputs): boolean {
  if (now < webglCooldownUntil) return true;
  if (dpr >= 2) return false;
  return selected || now - lastStreamTs > STREAM_QUIET_MS;
}
