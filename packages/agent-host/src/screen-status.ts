/**
 * An agent's status read from its screen: the fallback for an agent whose hooks have not
 * reported (or that has none). The daemon runs the agent's own detector (its manifest's
 * `detect` rules) on the headless screen it keeps for every session, a poll at a time.
 */
import type { TileStatus } from "@hivemind/agents";

/**
 * A screen, sampled every poll, can show an agent's idle prompt for a moment between two
 * steps of the same turn. Hold a working→idle flip for SCREEN_WORKING_HOLD_MS: a reading
 * of idle this soon after working is taken as that gap, not the end of the turn. Set above
 * the 1200ms scan interval so an end needs a second confirming idle scan. Only the screen
 * fallback uses it; hooks say when a turn ends. `lastWorkingAt.t` mutates across polls.
 */
export const SCREEN_WORKING_HOLD_MS = 2000;

export function stabilizeScreenStatus(
  prev: TileStatus,
  raw: TileStatus,
  now: number,
  lastWorkingAt: { t: number | null },
): TileStatus {
  if (raw === "working") {
    lastWorkingAt.t = now;
    return "working";
  }
  // Needs-human states are authoritative — never hold them back.
  if (raw === "permission" || raw === "question" || raw === "blocked") return raw;
  if (raw === "idle" && prev === "working") {
    if (lastWorkingAt.t !== null && now - lastWorkingAt.t < SCREEN_WORKING_HOLD_MS) {
      return "working";
    }
    return "idle";
  }
  return raw;
}


/** Reads the screens of sessions that produced output since the last tick, and reports each
 *  one's status when it changes. */
export class ScreenWatcher {
  private dirty = new Set<string>();
  private seen = new Map<string, { status: TileStatus; lastWorkingAt: { t: number | null } }>();

  constructor(private readonly o: {
    /** The session's screen and what it runs, or undefined when it is gone. */
    read: (id: string) => { cmd: string; screen: string } | undefined;
    /** The agent's own detector for what it runs; undefined for a program that is not an agent. */
    detect: (cmd: string, screen: string) => TileStatus | undefined;
    report: (id: string, status: TileStatus) => void;
    now?: () => number;
  }) {}

  output(id: string): void { this.dirty.add(id); }

  /** Every session's last reported reading, for a viewer that just connected. */
  current(): Array<[string, TileStatus]> { return [...this.seen].map(([id, s]) => [id, s.status]); }

  forget(id: string): void { this.dirty.delete(id); this.seen.delete(id); }

  tick(): void {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const s = this.o.read(id);
      if (!s) { this.seen.delete(id); continue; }
      const raw = this.o.detect(s.cmd, s.screen);
      if (!raw) continue;
      const prev = this.seen.get(id) ?? { status: "idle" as TileStatus, lastWorkingAt: { t: null } };
      const next = stabilizeScreenStatus(prev.status, raw, this.o.now?.() ?? Date.now(), prev.lastWorkingAt);
      const first = !this.seen.has(id);
      this.seen.set(id, { status: next, lastWorkingAt: prev.lastWorkingAt });
      if (first || next !== prev.status) this.o.report(id, next);
      // A held reading is looked at again next tick, output or not, so the hold can end.
      if (next !== raw) this.dirty.add(id);
    }
  }
}
