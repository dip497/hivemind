/**
 * An agent's status read from its screen: the fallback for an agent whose hooks have not
 * reported (or that has none). The daemon runs the agent's own detector (its manifest's
 * `detect` rules) on the headless screen it keeps for every session, a poll at a time.
 */
import type { ScreenReading, TileStatus } from "@hivemind/agents";
import { oneLine } from "./one-line.js";
import type { Cursor } from "./screen-messages.js";

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


/** A box-drawing, block or braille glyph. */
const GLYPH = /[\u2500-\u259f\u2800-\u28ff]/;
/** A row of only those glyphs, spaces and punctuation: a box's edge, a rule, a bar's track. The
 *  punctuation is spelled out (ASCII's, the middle dot, General Punctuation's) and not `\p{P}`,
 *  which V8 runs about three times slower, here on the daemon's I/O thread. */
const DRAWN = /^[\s\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e\u00b7\u2010-\u2027\u2030-\u205e\u2500-\u259f\u2800-\u28ff]*$/;

/**
 * The line a screen ends on: walking up, the first row with text that is not drawn only of glyphs,
 * as one line of plain text (one-line.ts). "" when there is none.
 *
 * While the cursor shows and the session's own program holds the terminal (`own`; undefined where
 * that cannot be told), the cursor waits in that program's input: a shell's prompt, an agent's
 * input box. The walk starts above it: the input's rows (from `cursor.top`: a marked prompt of two
 * rows, a command typed past the width) are what the person types, and the rows under it are that
 * input's own chrome (a footer, a completion list). While a command the shell ran holds the
 * terminal, the cursor waits on its question (`Overwrite b? [y/N]`, a password), which is the
 * line. A question the shell asks itself (`read -p`) is its prompt's, and is passed over.
 */
export function lastLine(screen: string, cursor: Cursor, own = true): string {
  const rows = screen.split("\n");
  const from = !cursor.hidden && own ? cursor.top - 1 : rows.length - 1;
  for (let y = Math.min(from, rows.length - 1); y >= 0; y--) {
    const l = oneLine(rows[y]!);
    if (l && !(GLYPH.test(l) && DRAWN.test(l))) return l;
  }
  return "";
}

/** Reads the screens of sessions that produced output since the last tick, and reports each
 *  one's reading when it changes: its status, or for a wait, the screen it says it is; and its
 *  last line. */
export class ScreenWatcher {
  private dirty = new Set<string>();
  private seen = new Map<string, { reading: ScreenReading; lastBusyAt: { t: number | null } }>();
  private lines = new Map<string, string>();

  constructor(private readonly o: {
    /** Each session's screen, its cursor and what it runs, and whether that holds its terminal
     *  (`lastLine`'s `own`); a session that is gone is left out. Null: the screens could not be
     *  read this time, which says nothing about the sessions. */
    read: (ids: string[]) => Promise<Map<string, { cmd: string; screen: string; cursor: Cursor; own?: boolean }> | null>;
    /** The agent's own detector for what it runs; undefined for a program that is not an agent. */
    detect: (cmd: string, screen: string) => ScreenReading | undefined;
    report: (id: string, reading: ScreenReading) => void;
    /** A session's last line, as it changes: "" once, when the line told goes blank. */
    line?: (id: string, line: string) => void;
    now?: () => number;
  }) {}

  output(id: string): void { this.dirty.add(id); }

  /** Every session's last reported reading, for a viewer that just connected. */
  current(): Array<[string, ScreenReading]> { return [...this.seen].map(([id, s]) => [id, s.reading]); }

  /** Every session's last line told, for a viewer that just connected. */
  currentLines(): Array<[string, string]> { return [...this.lines]; }

  forget(id: string): void { this.dirty.delete(id); this.seen.delete(id); this.lines.delete(id); }

  /** A tick that starts while the last one waits for its screens is skipped: the screens it would
   *  read are still dirty for the next. */
  private reading = false;

  async tick(): Promise<void> {
    if (this.reading || this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    this.reading = true;
    let got: Map<string, { cmd: string; screen: string; cursor: Cursor; own?: boolean }> | null;
    try { got = await this.o.read(ids); } finally { this.reading = false; }
    if (!got) { for (const id of ids) this.dirty.add(id); return; }
    for (const id of ids) {
      const s = got.get(id);
      if (!s) { this.seen.delete(id); continue; }
      if (this.o.line) {
        const line = lastLine(s.screen, s.cursor, s.own);
        // A screen cleared no longer says what it said: its blank is told, once. A screen that
        // never had a line says nothing.
        if ((this.lines.get(id) ?? "") !== line) {
          this.lines.set(id, line);
          this.o.line(id, line);
        }
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
