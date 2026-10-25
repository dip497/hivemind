/**
 * How an agent's status looks wherever Hivemind shows one, the app and every view alike: its word,
 * its mark (a shape, so no state is told by colour alone) and whether it pulses. The app's Layers,
 * headers and notifications draw from this table, and a view that shows a status imports it rather
 * than drawing its own dots. The colour is the host's `--hm-status-<tone>` (`applyThemeVars`).
 */
import type { StatusTone } from "./protocol.js";

export interface StatusMark {
  /** The state in a word, in sentence case where it starts a line. */
  word: string;
  /** The mark: an SVG path in a 10×10 box, filled with the tone's colour (even-odd). */
  path: string;
  /** Only what waits on the person pulses (apps/desktop/DESIGN.md, The One Voice Rule). */
  pulse: boolean;
}

const CIRCLE = "M5 0.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9Z";

export const STATUS_MARKS: Readonly<Record<StatusTone, StatusMark>> = {
  working: { word: "working", path: CIRCLE, pulse: false },
  attention: { word: "needs you", path: "M5 0.5L9.8 9.3H0.2Z", pulse: true },
  // Finished since the person last looked.
  done: { word: "finished", path: "M5 0L10 5L5 10L0 5Z", pulse: false },
  failed: { word: "failed", path: "M2.2 0.8L5 3.6L7.8 0.8L9.2 2.2L6.4 5L9.2 7.8L7.8 9.2L5 6.4L2.2 9.2L0.8 7.8L3.6 5L0.8 2.2Z", pulse: false },
  idle: { word: "idle", path: `${CIRCLE}M5 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z`, pulse: false },
  exited: { word: "exited", path: "M1 1H9V9H1Z", pulse: false },
};

/** A tone's mark as an `<svg>` string, coloured with the host's status colour, for a view that draws
 *  its own markup. `size` in pixels (DESIGN.md: 6px in rows, 8 to 10px where it stands alone). */
export function statusMarkSvg(tone: StatusTone, size = 8): string {
  const m = STATUS_MARKS[tone];
  return `<svg viewBox="0 0 10 10" width="${size}" height="${size}" aria-hidden="true" data-status="${tone}" style="flex:none;color:var(--hm-status-${tone})"><path d="${m.path}" fill="currentColor" fill-rule="evenodd"/></svg>`;
}
