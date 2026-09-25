/**
 * Agent status bus — a tiny pub/sub so tiles, panels and views read one status per tile
 * without prop drilling.
 *
 * Two sources, never mixed for one tile:
 *   - HOSTED: an agent session's status from the host's status store (main), pushed on every
 *     change. It already folds hooks, the screen fallback, exits and interrupts.
 *   - LOCAL: what a tile says about itself when it is not an agent session — a plain shell's
 *     activity — and the exit details (code, signal) only the tile sees.
 */
import type { SessionStatus } from "@hivemind/agent-host/status-store";

export type TileStatusKind =
  | "working"
  | "idle"
  | "blocked"
  | "permission"
  | "question"
  | "exited"
  | "plan_review"        // handed off a plan — waiting for a person's review
  | "awaiting_approval"; // supervised worker — waiting for its supervisor

export interface StatusEvent {
  tileId: string;
  /** Human label for chips/toasts, e.g. "claude #2 · plan". */
  label: string;
  status: TileStatusKind;
  /** True for an `idle` that is not the agent finishing (the user interrupted it): the
   *  awareness layer updates the status but does not announce a finish. */
  synthetic?: boolean;
  /** Process exit code, on an `exited` status from a PTY exit: a crash (non-zero) vs a close. */
  exitCode?: number;
  /** One-line detail: why an exit or a turn ended the way it did. */
  detail?: string;
}

type Listener = (e: StatusEvent) => void;

const listeners = new Set<Listener>();
/** Per-tile listeners (a view colouring one object per tile subscribes here). */
const tileListeners = new Map<string, Set<Listener>>();
const local = new Map<string, StatusEvent>();
const hosted = new Map<string, SessionStatus>();
const labels = new Map<string, string>();
const emitted = new Map<string, StatusEvent>();

const WAITING: Record<NonNullable<SessionStatus["kind"]>, TileStatusKind> = {
  permission: "permission", question: "question", plan: "plan_review", approval: "awaiting_approval", other: "blocked",
};
const ENDED: Partial<Record<SessionStatus["state"], string>> = { failed: "turn failed", limited: "usage limit reached", interrupted: "interrupted" };

/** A hosted status, as the kinds tiles and views colour by. */
export function tileStatusOf(s: SessionStatus): Pick<StatusEvent, "status" | "synthetic" | "detail"> {
  if (s.state === "exited") return { status: "exited" };
  if (s.state === "waiting") return { status: WAITING[s.kind ?? "other"] };
  if (s.state === "working" || s.subagents.length > 0) return { status: "working" };
  const detail = ENDED[s.state];
  return { status: "idle", ...(detail ? { detail } : {}), ...(s.state === "interrupted" ? { synthetic: true } : {}) };
}

function effective(tileId: string): StatusEvent | undefined {
  const l = local.get(tileId);
  const h = hosted.get(tileId);
  const label = labels.get(tileId) ?? l?.label ?? tileId;
  // The tile saw its process exit and knows how; that detail outranks the host's bare "exited".
  if (l?.status === "exited") return { ...l, label };
  if (h) return { tileId, label, ...tileStatusOf(h) };
  return l ? { ...l, label } : undefined;
}

/** Emit the tile's effective status if it changed since the last emit. */
function flush(tileId: string): void {
  const eff = effective(tileId);
  if (!eff) return;
  const prev = emitted.get(tileId);
  if (prev && prev.status === eff.status && prev.label === eff.label && prev.detail === eff.detail) return;
  emitted.set(tileId, eff);
  for (const l of listeners) l(eff);
  const tl = tileListeners.get(tileId);
  if (tl) for (const l of tl) l(eff);
}

/** A tile's own status: a plain shell's activity, or how its process exited. */
export function publishStatus(e: StatusEvent): void {
  local.set(e.tileId, e);
  flush(e.tileId);
}

/** The host's status for an agent session (from main's status store). */
export function setHostedStatus(tileId: string, status: SessionStatus): void {
  hosted.set(tileId, status);
  flush(tileId);
}

/** The name a tile's chips and toasts use. */
export function setLabel(tileId: string, label: string): void {
  if (labels.get(tileId) === label) return;
  labels.set(tileId, label);
  flush(tileId);
}

export function subscribeStatus(l: Listener): () => void {
  listeners.add(l);
  // Replay every live tile's last status, so a panel that mounts late is not stale.
  for (const e of emitted.values()) l(e);
  return () => {
    listeners.delete(l);
  };
}

/** Subscribe to ONE tile's effective status: replays the last one, then every transition. */
export function subscribeTileStatus(tileId: string, l: Listener): () => void {
  let set = tileListeners.get(tileId);
  if (!set) { set = new Set(); tileListeners.set(tileId, set); }
  set.add(l);
  const last = emitted.get(tileId);
  if (last) l(last);
  return () => {
    const cur = tileListeners.get(tileId);
    if (!cur) return;
    cur.delete(l);
    if (cur.size === 0) tileListeners.delete(tileId);
  };
}

/** Drop what a tile said about itself (call on tile unmount). The host's status stays: the
 *  session outlives its tile's mount. */
export function clearStatus(tileId: string): void {
  local.delete(tileId);
  labels.delete(tileId);
  emitted.delete(tileId);
}

/** Last-known effective status of a tile, or null if none recorded. */
export function statusOf(tileId: string): TileStatusKind | null {
  return effective(tileId)?.status ?? null;
}
