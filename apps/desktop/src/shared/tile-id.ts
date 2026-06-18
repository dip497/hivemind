/**
 * The HCP tile-id seam — ONE place for the bare↔pty id mapping.
 *
 * Two namespaces flow through the control plane:
 *   - BARE id  — `tile-claude-<ts>`: what the renderer's tiles array + tile.list
 *     expose, and what every MCP/CLI driver passes back in.
 *   - PTY id   — `hm:<bareId>` (a persistent daemon pty, see TerminalTile): the
 *     key for the pty itself, the OutputRecorder, the TurnTracker, and the
 *     injected `HIVEMIND_TILE` env (so the Stop hook reports under it).
 *
 * Centralized here because scattering `"hm:" + id` / `.slice(3)` across main,
 * the renderer, and the daemon is the bug class the HCP review flagged
 * (values crossing the namespace boundary without conversion).
 */
export const HM_PREFIX = "hm:";

/** Bare id → pty id (idempotent). */
export const toPtyId = (id: string): string => (id.startsWith(HM_PREFIX) ? id : HM_PREFIX + id);

/** Pty id → bare id (idempotent). */
export const toBareId = (id: string): string => (id.startsWith(HM_PREFIX) ? id.slice(HM_PREFIX.length) : id);
