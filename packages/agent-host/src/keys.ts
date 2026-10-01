/** Symbolic key → terminal bytes, for driving a TUI (answering a picker, dismissing a screen).
 *  A raw ESC byte cannot travel as plain text through a tool call or a manifest, so both go
 *  through these tokens; anything unknown is sent as itself, so digits and words type. */
const KEYMAP: Record<string, string> = {
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  enter: "\r", return: "\r", esc: "\x1b", escape: "\x1b",
  tab: "\t", space: " ", backspace: "\x7f", del: "\x1b[3~", delete: "\x1b[3~",
  home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
};

/** Gap between successive keys, so a TUI registers each one: a bundled arrow+enter can miss
 *  the move. Mirrors SUBMIT_DELAY_MS. */
export const KEY_GAP_MS = 40;

export function keyBytes(token: string): string {
  return KEYMAP[token.toLowerCase()] ?? token;
}
