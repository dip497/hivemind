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
  /** True when this `idle` is a STALENESS CORRECTION (a stuck "working" decayed
   *  because output stopped), NOT a real completion. The awareness layer updates
   *  the status but must NOT treat it as "finished" — no toast, no OS
   *  notification, no done-unseen highlight. A real finish (Stop hook / scrape
   *  idle) is unmarked and still notifies. */
  synthetic?: boolean;
}

type Listener = (e: StatusEvent) => void;

const listeners = new Set<Listener>();
const base = new Map<string, StatusEvent>();          // scrape-driven
const overrides = new Map<string, TileStatusKind>();  // control-plane wait states
const subagentBusy = new Set<string>();                // tiles with in-flight subagents
const notify = new Map<string, TileStatusKind>();      // claude Notification "needs you"
const liveTurn = new Map<string, "working" | "idle">(); // claude hook-driven turn state
const lastOutputAt = new Map<string, number>();        // last pty-output time per tile
const emitted = new Map<string, StatusEvent>();        // last EFFECTIVE emitted

// Ground-truth staleness window. A genuinely-working agent STREAMS pty output —
// an animated spinner, an elapsed-seconds timer, streaming tokens — i.e. it
// updates its screen roughly every second. A finished / interrupted / killed /
// restart-replayed tile is QUIET. So a "working" claim (from a hook turn OR the
// scrape) with no pty output for this long is stale and must read idle. This is
// the universal self-heal: unlike the scrape, it can't itself freeze on a stale
// buffer, and unlike the Stop hook it can't be missed by an Esc-interrupt.
const WORKING_STALE_MS = 15000;

function effective(tileId: string): StatusEvent | undefined {
  const b = base.get(tileId);
  const here = (status: TileStatusKind, synthetic?: boolean): StatusEvent =>
    ({ tileId, label: b?.label ?? tileId, status, ...(synthetic ? { synthetic: true } : {}) });
  const ov = overrides.get(tileId);
  // 1. Explicit control-plane wait (plan_review / awaiting_approval) — a terminal
  //    pause the app set deliberately. Authoritative over everything.
  if (ov) return here(ov);
  // 2. Needs-you — a real human-required state. From the scrape base
  //    (permission/question/blocked) or claude's Notification hook. A turn paused
  //    for you must read "needs you", never a stale "working".
  if (b && (b.status === "permission" || b.status === "question" || b.status === "blocked")) return b;
  const n = notify.get(tileId);
  if (n && (!b || b.status === "idle")) return here(n);
  // 3. Exited — the process is gone; never mask it as working/idle.
  if (b && b.status === "exited") return b;
  // 4. Background subagents in flight → working (covers a finished main turn that
  //    still has background agents running). Event-driven (with its own lost-edge
  //    reaper) and legitimately QUIET — so NOT subject to the output-staleness
  //    gate below.
  if (subagentBusy.has(tileId)) return here("working");
  // STALENESS: any "working" claim (hook turn OR scrape) must be backed by recent
  // pty output (see WORKING_STALE_MS). A working agent streams output; a finished/
  // interrupted/killed/restart-replayed tile is quiet. So a "working" gone quiet
  // for the window is stale → idle. This corrects BOTH a missed Stop hook (Esc /
  // crash pins liveTurn "working") AND a frozen "working" scrape the poll can't
  // re-evaluate (no new output) — neither of which the scrape's own idle could fix.
  // Gate only once the tile has produced output at least once (so a working
  // status is coupled to a real stream); a tile that never emitted is governed
  // by the hook/scrape as before. In production publishStatus("working") is
  // always preceded by the pty-data event that called noteOutput, so a fresh
  // "working" is never stale — only one gone quiet for the window is.
  const lastOut = lastOutputAt.get(tileId);
  const stale = lastOut !== undefined && Date.now() - lastOut > WORKING_STALE_MS;
  // 5. Hook-driven turn state (claude/droid): UserPromptSubmit → working, Stop →
  //    idle. Authoritative over the scrape — immune to spinner/wording changes,
  //    focus/scroll, stale buffer replay. Unset for hook-less agents → scrape.
  const lt = liveTurn.get(tileId);
  if (lt === "working") {
    if (b?.status === "idle") return b;          // real scrape idle → real finish
    if (stale) return here("idle", true);         // output stopped → SYNTHETIC idle
    return here("working");
  }
  if (lt === "idle") return here("idle"); // dominates a spinner false-"working"
  // 6. Scrape base — the fallback (hook-less working/idle; claude before seeding).
  //    A scraped "working" that's gone quiet is a frozen/stale screen → SYNTHETIC idle.
  if (b?.status === "working" && stale) return here("idle", true);
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
  // Auto-clear a "needs you" notify once the scrape moves OFF idle: the scrape is
  // then authoritative (it shows permission/working/… itself). Keeps notify from
  // sticking after the user answers and work resumes.
  if (e.status !== "idle") notify.delete(e.tileId);
  flush(e.tileId);
}

/** Force a control-plane "wait" status (plan_review / awaiting_approval) that
 *  OVERRIDES the scraped status until cleared with null. */
export function setWaitStatus(tileId: string, status: TileStatusKind | null): void {
  if (status) overrides.set(tileId, status);
  else overrides.delete(tileId);
  flush(tileId);
}

/** Mark whether a tile has in-flight Task subagents (from the SubagentStart/Stop
 *  hooks via main). While busy, the tile's effective status is lifted to
 *  "working" if its scrape reads idle — covers background agents the scrape
 *  misses. Does not mask needs-human states (see effective()). */
export function setSubagentBusy(tileId: string, busy: boolean): void {
  if (busy === subagentBusy.has(tileId)) return;
  if (busy) subagentBusy.add(tileId);
  else subagentBusy.delete(tileId);
  flush(tileId);
}

/** Set a deterministic "needs you" status (permission / question) from claude's
 *  Notification hook, or null to clear. Soft — lifts an idle tile only and is
 *  auto-cleared by the scrape (see publishStatus / effective). */
export function setNotify(tileId: string, status: TileStatusKind | null): void {
  if (status) {
    if (notify.get(tileId) === status) return;
    notify.set(tileId, status);
  } else if (!notify.delete(tileId)) {
    return;
  }
  flush(tileId);
}

/** Set claude's hook-driven turn state — "working" (UserPromptSubmit) or "idle"
 *  (Stop) — or null to clear. Authoritative over the scrape for working/idle (see
 *  effective). Seed "idle" on a claude tile's mount so a re-attached tile reads
 *  idle until a real turn fires, not the stale scraped "working". */
export function setTurnState(tileId: string, state: "working" | "idle" | null): void {
  if (state) {
    if (liveTurn.get(tileId) === state) return;
    liveTurn.set(tileId, state);
  } else if (!liveTurn.delete(tileId)) {
    return;
  }
  flush(tileId);
}

/** Note that a tile just produced pty output (the ground-truth "alive" signal).
 *  Called from TerminalTile on every pty data event — keeps a "working" status
 *  honored; its absence is what lets the staleness gate decay a stuck "working"
 *  to idle. Cheap (a timestamp write); does NOT flush. */
export function noteOutput(tileId: string, at: number = Date.now()): void {
  lastOutputAt.set(tileId, at);
}

/** Re-evaluate + emit a tile's effective status NOW (no input change). The
 *  staleness gate is time-based, so a tile that's gone quiet won't transition to
 *  idle on its own — TerminalTile's poll calls this each tick so a stale
 *  "working" decays to idle even with no further status events. */
export function revalidate(tileId: string): void {
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
  subagentBusy.delete(tileId);
  notify.delete(tileId);
  liveTurn.delete(tileId);
  lastOutputAt.delete(tileId);
  emitted.delete(tileId);
}

/** Last-known effective status of a tile, or null if none recorded. */
export function statusOf(tileId: string): TileStatusKind | null {
  return effective(tileId)?.status ?? null;
}
