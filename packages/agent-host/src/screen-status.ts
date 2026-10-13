/**
 * An agent's status read from its screen: the fallback for an agent whose hooks have not
 * reported (or that has none). The daemon runs the agent's own detector (its manifest's
 * `detect` rules) on the headless screen it keeps for every session, a poll at a time.
 */
import type { ScreenReading, TileStatus } from "@hivemind/agents";

/**
 * A screen, sampled every poll, can show an agent's idle prompt for a moment between two
 * steps of the same turn, or while a chooser is redrawn (a viewer's repaint cuts its footer).
 * Hold a flip to idle from working or a wait for SCREEN_WORKING_HOLD_MS: a reading of idle this
 * soon after either is taken as that gap. Set above the 1200ms scan interval so an end needs a
 * second confirming idle scan. `lastBusyAt.t` mutates across polls.
 */
export const SCREEN_WORKING_HOLD_MS = 2000;

export function stabilizeScreenStatus(
  prev: TileStatus,
  raw: TileStatus,
  now: number,
  lastBusyAt: { t: number | null },
): TileStatus {
  // Needs-human states are authoritative — never hold them back.
  if (raw === "working" || raw === "permission" || raw === "question" || raw === "blocked") {
    lastBusyAt.t = now;
    return raw;
  }
  const busy = prev === "working" || prev === "permission" || prev === "question" || prev === "blocked";
  if (raw === "idle" && busy && lastBusyAt.t !== null && now - lastBusyAt.t < SCREEN_WORKING_HOLD_MS) return prev;
  return raw;
}


/** The longest last line told. */
const LINE_MAX = 160;

/** The last line of `screen` with text, trimmed and cut to `LINE_MAX` characters. */
export function lastLine(screen: string): string {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (l) return [...l].slice(0, LINE_MAX).join("");
  }
  return "";
}

/** Reads the screens of sessions that produced output since the last tick, and reports each
 *  one's reading when it changes: its status, or for a wait, the screen it says it is; and its
 *  last line with text. */
export class ScreenWatcher {
  private dirty = new Set<string>();
  private seen = new Map<string, { reading: ScreenReading; lastBusyAt: { t: number | null } }>();
  private lines = new Map<string, string>();

  constructor(private readonly o: {
    /** The session's screen and what it runs, or undefined when it is gone. */
    read: (id: string) => { cmd: string; screen: string } | undefined;
    /** The agent's own detector for what it runs; undefined for a program that is not an agent. */
    detect: (cmd: string, screen: string) => ScreenReading | undefined;
    report: (id: string, reading: ScreenReading) => void;
    /** A session's last line with text, as it changes. */
    line?: (id: string, line: string) => void;
    now?: () => number;
  }) {}

  output(id: string): void { this.dirty.add(id); }

  /** Every session's last reported reading, for a viewer that just connected. */
  current(): Array<[string, ScreenReading]> { return [...this.seen].map(([id, s]) => [id, s.reading]); }

  /** Every session's last line told, for a viewer that just connected. */
  currentLines(): Array<[string, string]> { return [...this.lines]; }

  forget(id: string): void { this.dirty.delete(id); this.seen.delete(id); this.lines.delete(id); }

  tick(): void {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const s = this.o.read(id);
      if (!s) { this.seen.delete(id); continue; }
      const line = lastLine(s.screen);
      if (line && this.o.line && this.lines.get(id) !== line) {
        this.lines.set(id, line);
        this.o.line(id, line);
      }
      const raw = this.o.detect(s.cmd, s.screen);
      if (!raw) continue;
      const prev = this.seen.get(id) ?? { reading: { status: "idle" as TileStatus }, lastBusyAt: { t: null } };
      const status = stabilizeScreenStatus(prev.reading.status, raw.status, this.o.now?.() ?? Date.now(), prev.lastBusyAt);
      const next: ScreenReading = status === raw.status ? raw : prev.reading;
      const first = !this.seen.has(id);
      this.seen.set(id, { reading: next, lastBusyAt: prev.lastBusyAt });
      if (first || next.status !== prev.reading.status || next.says !== prev.reading.says) this.o.report(id, next);
      // A held reading is looked at again next tick, output or not, so the hold can end.
      if (status !== raw.status) this.dirty.add(id);
    }
  }
}
