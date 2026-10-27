/**
 * OSC 52: a terminal program puts text on the clipboard (`ESC ] 52 ; c ; <base64> BEL`). Claude Code
 * in fullscreen copies what you select with the mouse this way. Only writes are taken: a program
 * asking to read the clipboard (`?`) is told nothing.
 */
import type { IParser } from "@xterm/xterm";

/** The most text one write may put there. */
export const CLIPBOARD_MAX = 1024 * 1024;

/** The text an OSC 52 payload (`<targets>;<base64>`) writes, or null: a read, an empty or
 *  oversized write, or one that is not base64. */
export function clipboardWrite(payload: string): string | null {
  const at = payload.indexOf(";");
  if (at < 0) return null;
  const data = payload.slice(at + 1);
  if (!data || data === "?" || data.length > Math.ceil(CLIPBOARD_MAX / 3) * 4) return null;
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Takes OSC 52 writes to the clipboard while `allowed` says the person is at this terminal. */
export function takeClipboardWrites(parser: IParser, allowed: () => boolean, write: (text: string) => void): { dispose(): void } {
  return parser.registerOscHandler(52, (payload) => {
    const text = allowed() ? clipboardWrite(payload) : null;
    if (text) write(text);
    return true;
  });
}
