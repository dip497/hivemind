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

/** App keys that are a plain letter with the modifier: only ⌘ (macOS) takes them from a terminal.
 *  Ctrl+B belongs to the program there (run in background, tmux's prefix, readline); the
 *  renderer handles them when no terminal or field has focus. */
export function menuKey(i: KeyInput): "toggle-layers" | null {
  if (!i.meta || i.control || i.alt || i.shift) return null;
  return i.key.toLowerCase() === "b" ? "toggle-layers" : null;
}

/** What an app key tells the page, as main sends it to a window and a browser tab raises it
 *  itself: the message's channel and its arguments. Null: the key is the focused tile's. */
export function appKeyMessage(i: KeyInput): [channel: string, ...args: string[]] | null {
  if (!(i.control || i.meta) || i.alt) return null;
  const action = appShortcut(i);
  if (action) return ["menu:shortcut", action];
  const k = i.key.toLowerCase();
  // Ctrl/Cmd+Shift+F toggles the selected tile's fit-to-screen overlay; +0 resets its scale.
  if (i.shift) return k === "f" ? ["menu:fit-overlay"] : k === "0" || k === ")" ? ["menu:reset-scale"] : null;
  // Plain `.` is the terminal's, so focusing the selected tile takes the modifier.
  if (k === ".") return ["menu:focus-tile"];
  const menu = menuKey(i);
  return menu ? [`menu:${menu}`] : null;
}

/** Quit: ⌘Q on macOS, Ctrl+Q elsewhere, taken from a terminal too as VS Code takes it. Main
 *  handles it; a browser tab on the app has no app to quit. */
export function isQuitKey(i: KeyInput, platform: string): boolean {
  if (i.alt || i.shift || i.key.toLowerCase() !== "q") return false;
  return platform === "darwin" ? i.meta && !i.control : i.control && !i.meta;
}
