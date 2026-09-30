/**
 * The HCP tile-id seam — ONE place for the bare↔pty id mapping.
 *
 * Two namespaces flow through the control plane:
 *   - BARE id  — `tile-claude-<ts>`: what the renderer's tiles array + tile.list
 *     expose, and what every driver (`hive ctl`, the pi extension) passes back in.
 *   - PTY id   — `hm:<bareId>` (a persistent daemon pty, see TerminalTile): the
 *     key for the pty itself, the OutputRecorder, the TurnTracker, and the
 *     injected `HIVEMIND_TILE` env (so the Stop hook reports under it).
 *
 * Centralized here because scattering `"hm:" + id` / `.slice(3)` across main,
 * the renderer, and the daemon is the bug class the HCP review flagged
 * (values crossing the namespace boundary without conversion).
 */
export const HM_PREFIX = "hm:";

let lastMinted = 0;
/**
 * A fresh `<prefix>-<n>` id. The clock alone repeats within a millisecond, which a fanout of
 * workers hits, and main and each window mint ids of their own: `n` is the clock's milliseconds
 * times a thousand plus a random 0–999, and never less than one more than the last.
 */
export function mintId(prefix: string): string {
  lastMinted = Math.max(Date.now() * 1000 + Math.floor(Math.random() * 1000), lastMinted + 1);
  return `${prefix}-${lastMinted}`;
}

/** Bare id → pty id (idempotent). */
export const toPtyId = (id: string): string => (id.startsWith(HM_PREFIX) ? id : HM_PREFIX + id);

/** Pty id → bare id (idempotent). */
export const toBareId = (id: string): string => (id.startsWith(HM_PREFIX) ? id.slice(HM_PREFIX.length) : id);
