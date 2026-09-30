/**
 * Whether the user is at the machine (protocol 1.3): system input recency, with lock and suspend
 * as immediate "away". Keeps per-day totals of seconds in each state — never the times.
 */
import type { ViewPresence } from "@hivemind/view-sdk/protocol";

export type PresenceState = ViewPresence["state"];
export type PresenceTotals = Record<PresenceState, number>;

export const IDLE_AFTER_S = 2 * 60;
export const AWAY_AFTER_S = 10 * 60;
export const POLL_MS = 15_000;

export interface PresenceDeps {
  /** Seconds since the last system input. */
  idleSeconds: () => number;
  focused: () => boolean;
  now?: () => number;
  /** Local day key for a time (YYYY-MM-DD). */
  dayOf: (t: number) => string;
  onChange: (p: ViewPresence) => void;
  /** Called when a day's totals grew. */
  onTotals?: (day: string, totals: PresenceTotals) => void;
}

export class PresenceMonitor {
  private cur: ViewPresence;
  private locked = false;
  private lastCount: number;
  private totals = new Map<string, PresenceTotals>();
  private readonly now: () => number;

  constructor(private deps: PresenceDeps) {
    this.now = deps.now ?? (() => Date.now());
    const t = this.now();
    this.lastCount = t;
    this.cur = { state: this.compute(), since: t, focused: deps.focused() };
  }

  get current(): ViewPresence { return this.cur; }

  totalsFor(day: string): PresenceTotals { return { ...(this.totals.get(day) ?? { active: 0, idle: 0, away: 0 }) }; }

  /** Poll tick, and focus changes. */
  evaluate(): void {
    this.count();
    const state = this.compute();
    const focused = this.deps.focused();
    if (state === this.cur.state && focused === this.cur.focused) return;
    this.cur = { state, since: state === this.cur.state ? this.cur.since : this.now(), focused };
    this.deps.onChange(this.cur);
  }

  /** Screen locked or the machine is suspending: away at once. Unlock and resume re-evaluate. */
  setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.count();
    this.locked = locked;
    this.evaluate();
  }

  // Credit the time since the last count to the state that held, split at local midnight.
  private count(): void {
    const end = this.now();
    let start = this.lastCount;
    this.lastCount = end;
    while (start < end) {
      const day = this.deps.dayOf(start);
      const next = nextMidnight(start);
      const stop = Math.min(end, next);
      const tot = this.totals.get(day) ?? { active: 0, idle: 0, away: 0 };
      tot[this.cur.state] += (stop - start) / 1000;
      this.totals.set(day, tot);
      this.deps.onTotals?.(day, { ...tot });
      start = stop;
    }
  }

  private compute(): PresenceState {
    if (this.locked) return "away";
    const idle = this.deps.idleSeconds();
    return idle >= AWAY_AFTER_S ? "away" : idle >= IDLE_AFTER_S ? "idle" : "active";
  }
}

export function nextMidnight(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
