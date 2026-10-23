/** What the daemon's I/O thread and its screen worker (screen-worker.ts) say to each other. */
import type { Cursor } from "./pty-protocol.js";

/** Where a session's cursor is, as the daemon tells it (`x`, `y`: its column, and its row down from
 *  the top visible row), and for the line its screen ends on: `top`, the row the input it is in
 *  starts on (a prompt the shell marked, a command line that wraps), at most `y`; `hidden`, its
 *  program hid it (a prompt or an input box shows it); `marked`, the shell marked where its prompt
 *  starts (OSC 133 `A`), so `top` holds every row of it. */
export interface ScreenCursor extends Cursor { top: number; hidden: boolean; marked?: true }

/** A session's visible rows as text, and its cursor: a `Viewport` that always knows its cursor. */
export interface ScreenRows { text: string; cursor: ScreenCursor }

/** `epoch` names the session instance: what is sent for one whose id another now holds is ignored. */
export type ToScreens =
  /** A session's terminal, fed `seed` first (a saved screen, or recent output after a restart) and
   *  counting output from `parsed`. */
  | { t: "open"; id: string; epoch: string; cols: number; rows: number; scrollback: number; seed: string; parsed: number }
  /** Output up to position `end`, cut where a sequence ends. */
  | { t: "write"; id: string; epoch: string; data: string; end: number }
  | { t: "resize"; id: string; epoch: string; cols: number; rows: number }
  /** The screen as VT text with at most `lines` of scrollback. */
  | { t: "screen"; req: number; id: string; epoch: string; lines: number }
  /** The visible rows of each session, as text, and where its cursor is. */
  | { t: "rows"; req: number; ids: string[] }
  | { t: "close"; id: string; epoch: string };

export type FromScreens =
  /** `at`: the output position the screen covers; `mouse`: the mouse encoding the screen omits. */
  | { t: "screen"; req: number; text: string | null; at: number; modes: string }
  /** Each session's visible rows as text, and its cursor. */
  | { t: "rows"; req: number; rows: Array<[string, ScreenRows]> }
  /** How far each session's terminal has taken in its output: id, epoch, position. */
  | { t: "parsed"; at: Array<[string, string, number]> }
  /** The app turned bracketed paste on or off. `epoch`: the session instance (a reused id is another). */
  | { t: "paste"; id: string; epoch: string; on: boolean }
  | { t: "title"; id: string; epoch: string; title: string };
