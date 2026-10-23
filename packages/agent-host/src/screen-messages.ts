/** What the daemon's I/O thread and its screen worker (screen-worker.ts) say to each other. */
import type { Viewport } from "./pty-protocol.js";

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
  /** The visible rows of each session, as text, and its cursor. */
  | { t: "rows"; req: number; ids: string[] }
  | { t: "close"; id: string; epoch: string };

export type FromScreens =
  /** `at`: the output position the screen covers; `mouse`: the mouse encoding the screen omits. */
  | { t: "screen"; req: number; text: string | null; at: number; modes: string }
  | { t: "rows"; req: number; rows: Array<[string, Viewport]> }
  /** How far each session's terminal has taken in its output: id, epoch, position. */
  | { t: "parsed"; at: Array<[string, string, number]> }
  /** The app turned bracketed paste on or off. `epoch`: the session instance (a reused id is another). */
  | { t: "paste"; id: string; epoch: string; on: boolean }
  | { t: "title"; id: string; epoch: string; title: string };
