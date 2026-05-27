/**
 * Agent status bus — a tiny pub/sub so terminal tiles can broadcast their
 * detected state (working / idle / blocked / …) to the Canvas without prop
 * drilling. The Canvas uses it for herdr-style features: live-colored session
 * chips (the "sidebar"), toast notifications when an OFF-SCREEN agent needs you
 * or finishes, and the done-unseen highlight.
 *
 * Separate from claude-bus.ts (which routes send-to-claude text); this bus is
 * one-way, tile → Canvas, status only.
 */
export type TileStatusKind =
  | "working"
  | "idle"
  | "blocked"
  | "permission"
  | "question"
  | "exited";

export interface StatusEvent {
  tileId: string;
  /** Human label for chips/toasts, e.g. "claude #2 · plan". */
  label: string;
  status: TileStatusKind;
}

type Listener = (e: StatusEvent) => void;

const listeners = new Set<Listener>();
const last = new Map<string, StatusEvent>();

/** Publish a status. No-ops if the status+label is unchanged from last time —
 *  the poll re-asserts the same status every tick, so only real transitions
 *  reach subscribers. */
export function publishStatus(e: StatusEvent): void {
  const prev = last.get(e.tileId);
  if (prev && prev.status === e.status && prev.label === e.label) return;
  last.set(e.tileId, e);
  for (const l of listeners) l(e);
}

export function subscribeStatus(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Drop a tile's last-known status (call on tile unmount). */
export function clearStatus(tileId: string): void {
  last.delete(tileId);
}
