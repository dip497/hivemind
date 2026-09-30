/**
 * Delivering a message to an agent's TUI is a PASTE, not typing.
 *
 * Written raw, every newline in a multi-line prompt is an Enter: the TUI submits the first
 * line, then the second, and one that guards against a burst of input it cannot parse in time
 * discards the rest and exits. Bracketed paste — what a terminal sends when a human pastes —
 * hands the whole text over as one block, newlines and all, and the separate Enter that
 * follows submits it once.
 */
const START = "\x1b[200~";
const END = "\x1b[201~";

/**
 * The bytes to write for a message delivered into a TUI. `bracketed` is whether the app
 * running there turned bracketed paste on (`?2004h`) — the session's own terminal knows.
 * Without it the text goes in as one line: a newline would submit half a prompt.
 */
export function pasteText(text: string, bracketed: boolean): string {
  // An END inside the text would close the paste early and leave the rest as keystrokes.
  const body = text.split(END).join("");
  if (!bracketed) return body.split(/\r\n|\r|\n/).join(" ");
  return `${START}${body}${END}`;
}
