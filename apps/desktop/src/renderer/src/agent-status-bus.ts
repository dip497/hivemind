/**
 * Agent status bus — a tiny pub/sub so terminal tiles can broadcast their
 * detected state (working / idle / blocked / …) to the Canvas without prop
 * drilling. The Canvas uses it for herdr-style features: live-colored session
 * chips (the "sidebar"), toast notifications when an OFF-SCREEN agent needs you
 * or finishes, and the done-unseen highlight.
 *
 * Two sources, with an override:
 *   - BASE: the per-tile screen-scrape (working / idle / …), re-asserted on a poll.
 *   - OVERRIDE: control-plane "wait" states the app knows precisely — an agent
 *     blocked on plan review or on a supervisor's approval — set via
 *     setWaitStatus(). The override WINS over the scrape until cleared, so a
 *     paused agent reads "waiting: review" / "waiting: approval" instead of a
 *     misleading scraped "idle".
 *
 * Separate from claude-bus.ts (which routes send-to-claude text); this bus is
 * one-way, tile/control-plane → Canvas, status only.
 */
export type TileStatusKind =
  | "working"
  | "idle"
  | "blocked"
  | "permission"
  | "question"
  | "exited"
  // Control-plane "wait" states (set via setWaitStatus, override the scrape):
  | "plan_review"        // blocked handing off a plan — waiting for human review
  | "awaiting_approval"; // supervised worker — waiting for its parent to approve

export interface StatusEvent {
  tileId: string;
  /** Human label for chips/toasts, e.g. "claude #2 · plan". */
  label: string;
  status: TileStatusKind;
}

type Listener = (e: StatusEvent) => void;

const listeners = new Set<Listener>();
const base = new Map<string, StatusEvent>();          // scrape-driven
const overrides = new Map<string, TileStatusKind>();  // control-plane wait states
const emitted = new Map<string, StatusEvent>();        // last EFFECTIVE emitted

function effective(tileId: string): StatusEvent | undefined {
  const b = base.get(tileId);
  const ov = overrides.get(tileId);
  if (ov) return { tileId, label: b?.label ?? tileId, status: ov };
  return b;
}

/** Emit the tile's effective status if it changed since the last emit. */
function flush(tileId: string): void {
  const eff = effective(tileId);
  if (!eff) return;
  const prev = emitted.get(tileId);
  if (prev && prev.status === eff.status && prev.label === eff.label) return;
  emitted.set(tileId, eff);
  for (const l of listeners) l(eff);
}

/** Publish a SCRAPED status. Suppressed while a control-plane override is active
 *  (the override is authoritative until cleared). Only real transitions reach
 *  subscribers — the poll re-asserts the same status every tick. */
export function publishStatus(e: StatusEvent): void {
  base.set(e.tileId, e);
  flush(e.tileId);
}

/** Force a control-plane "wait" status (plan_review / awaiting_approval) that
 *  OVERRIDES the scraped status until cleared with null. */
export function setWaitStatus(tileId: string, status: TileStatusKind | null): void {
  if (status) overrides.set(tileId, status);
  else overrides.delete(tileId);
  flush(tileId);
}

export function subscribeStatus(l: Listener): () => void {
  listeners.add(l);
  // Replay the last effective status of every live tile to the NEW subscriber,
  // so a panel that mounts late doesn't show stale state until the next change.
  for (const e of emitted.values()) l(e);
  return () => {
    listeners.delete(l);
  };
}

/** Drop a tile's status (call on tile unmount). */
export function clearStatus(tileId: string): void {
  base.delete(tileId);
  overrides.delete(tileId);
  emitted.delete(tileId);
}

/** Last-known effective status of a tile, or null if none recorded. */
export function statusOf(tileId: string): TileStatusKind | null {
  return effective(tileId)?.status ?? null;
}
