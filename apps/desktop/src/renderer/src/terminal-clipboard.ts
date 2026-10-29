/**
 * OSC 52: a terminal program puts text on the clipboard (`ESC ] 52 ; c ; <base64> BEL`). Claude Code
 * in fullscreen copies what you select with the mouse this way. Only writes are taken: a program
 * asking to read the clipboard (`?`) is told nothing.
 */
import type { IParser } from "@xterm/xterm";
import type { StartImage } from "@hivemind/workspace-api/agents";

/** How soon after a screen's own input a program's copy is that screen's: a mouse selection is
 *  copied as its button comes up. */
export const COPY_AFTER_INPUT_MS = 2000;

/** The kinds of photo a terminal takes pasted. */
const PHOTO_TYPES: ReadonlySet<string> = new Set<StartImage["type"]>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The photo a paste carries without words, as the workspace takes one; null for anything else. */
export async function pastedPhoto(data: DataTransfer | null): Promise<StartImage | null> {
  if (!data || data.getData("text/plain")) return null;
  const file = [...data.files].find((f) => PHOTO_TYPES.has(f.type));
  if (!file) return null;
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { type: file.type as StartImage["type"], data: url.slice(url.indexOf(",") + 1) };
}

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
