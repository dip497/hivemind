/** VS Code's keys for app actions, resolved from a raw key event.
 *
 *  Main intercepts these before xterm, so they work from inside a terminal — the same keys
 *  VS Code keeps from the shell. Anything not listed goes to the focused tile, which is why
 *  they are Ctrl+Shift+… or Ctrl with a non-letter: plain Ctrl+letter belongs to the shell
 *  (Ctrl+L clears, Ctrl+W deletes a word, Ctrl+D ends input). */
export interface KeyInput { key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }

export function appShortcut(i: KeyInput): string | null {
  if (!(i.control || i.meta) || i.alt) return null;
  const k = i.key.toLowerCase();
  if (i.shift) {
    if (k === "~" || k === "`") return "new-terminal";
    if (k === "e") return "explorer";
    if (k === "g") return "diff";
    if (k === "a") return "agent";
    if (k === "n") return "new-frame";
    if (k === "tab") return "prev-tile";
    return null;
  }
  if (k === "tab") return "next-tile";
  if (/^[1-9]$/.test(k)) return `tile:${k}`;
  if (k === ",") return "settings";
  return null;
}
