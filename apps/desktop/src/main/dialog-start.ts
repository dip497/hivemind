/** Where a file dialog opens. Electron 43 starts every dialog without a `defaultPath` in
 *  Downloads and stops the OS remembering the last folder, so each picker remembers its own. */
import path from "node:path";

const last = new Map<string, string>();

export function dialogStart(kind: string, fallback: string): string {
  return last.get(kind) ?? fallback;
}

/** Note what the user picked. The next dialog opens beside it: a picked project's siblings,
 *  a picked file's folder. */
export function rememberPick(kind: string, picked: string): void {
  last.set(kind, path.dirname(picked));
}
