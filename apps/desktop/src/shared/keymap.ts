/** Every key the app answers, and where: the one list main, the window and a browser tab on the app
 *  read. A key not listed is the focused tile's, a terminal's program first of all.
 *
 *  - `anywhere`: taken before the focused tile sees it, from a terminal too. Only keys a terminal
 *    program has no use for, or that move you out of it: VS Code keeps the same few.
 *  - `canvas`: only while nothing is being typed into; in a terminal or a field the key is theirs.
 *  - `terminal`: the focused terminal's own: copy, a new line in a prompt, its font, taking back
 *    the keyboard.
 *
 *  Keys that share a chord are tried in order: an action that has nothing to do (no selection, no
 *  arrow being drawn) leaves the key to the next, and the last to the program. */
import { type Chord, type KeyPress, pressIs, readChord } from "@hivemind/view-sdk/commands";

export type Where = "anywhere" | "canvas" | "terminal";

/** What each action does, in the words Settings ▸ Shortcuts shows. The page is made from the keymap,
 *  so a row's action needs words here to typecheck. `tile` is `tile:1` … `tile:9`. */
const DOES = {
  quit: "Quit, asking first while agents or terminals run",
  "window-fullscreen": "Full screen",
  "new-terminal": "New terminal",
  explorer: "The Code tile, on its files",
  agent: "New agent, your default one",
  "new-frame": "New frame",
  "next-tile": "Next tile",
  "prev-tile": "Previous tile",
  tile: "Go to tile 1 … 9",
  settings: "Settings",
  "fit-to-screen": "Fit the selected terminal to the screen, and back",
  "reset-scale": "Size the selected terminal's text to the screen",
  "focus-selected": "Focus the selected tile",
  "toggle-layers": "Show or hide the Layers panel",
  "toggle-view-mode": "Switch views, in any view",
  undo: "Undo on the board",
  redo: "Redo on the board",
  duplicate: "Duplicate the selected widget",
  "zoom-reset": "Zoom to 100%",
  "zoom-in": "Zoom in",
  "zoom-out": "Zoom out",
  "open-folder": "Open a folder as the project",
  "open-recent": "Open a recent project",
  "close-tile": "Close the selected tile",
  "stop-arrow": "Stop drawing an arrow",
  "leave-fullscreen": "Leave full screen",
  deselect: "Deselect on the board",
  "fit-all": "Fit everything in view",
  undock: "Undock a tile from a scene view",
  "new-browser": "New browser",
  "remove-selected": "Delete the selected widget or arrow",
  "rename-frame": "Rename the selected frame",
  copy: "Copy the selection; with none, the key goes to the program",
  "new-line": "A new line in an agent's prompt",
  "take-keyboard": "Take back the keyboard from a guest",
  "font-bigger": "Bigger text",
  "font-smaller": "Smaller text",
  "font-reset": "Text back to its size",
} as const;

export type Action = Exclude<keyof typeof DOES, "tile"> | `tile:${number}`;

export interface Binding {
  /** `mod` is Cmd on a Mac, Ctrl elsewhere. */
  keys: string;
  where: Where;
  action: Action;
}

/** What an action does, in a few words. */
export function doesWhat(action: Action): string {
  return action.startsWith("tile:") ? DOES.tile : DOES[action as Exclude<Action, `tile:${number}`>];
}

const tiles = Array.from({ length: 9 }, (_, i) => ({ keys: `mod+${i + 1}`, where: "anywhere", action: `tile:${i + 1}` }) as const);

/** In the order Settings ▸ Shortcuts lists them: everyday keys first, Quit last. */
export const KEYMAP: readonly Binding[] = [
  { keys: "mod+shift+`", where: "anywhere", action: "new-terminal" },
  { keys: "mod+shift+e", where: "anywhere", action: "explorer" },
  { keys: "mod+shift+a", where: "anywhere", action: "agent" },
  { keys: "mod+shift+n", where: "anywhere", action: "new-frame" },
  { keys: "ctrl+tab", where: "anywhere", action: "next-tile" },
  { keys: "ctrl+shift+tab", where: "anywhere", action: "prev-tile" },
  ...tiles,
  { keys: "mod+,", where: "anywhere", action: "settings" },
  { keys: "mod+shift+f", where: "anywhere", action: "fit-to-screen" },
  { keys: "mod+shift+0", where: "anywhere", action: "reset-scale" },
  { keys: "mod+.", where: "anywhere", action: "focus-selected" },
  { keys: "meta+b", where: "anywhere", action: "toggle-layers" },
  { keys: "f11", where: "anywhere", action: "window-fullscreen" },
  { keys: "mod+q", where: "anywhere", action: "quit" },

  { keys: "mod+e", where: "canvas", action: "toggle-view-mode" },
  { keys: "mod+z", where: "canvas", action: "undo" },
  { keys: "mod+shift+z", where: "canvas", action: "redo" },
  { keys: "mod+y", where: "canvas", action: "redo" },
  { keys: "mod+d", where: "canvas", action: "duplicate" },
  { keys: "mod+0", where: "canvas", action: "zoom-reset" },
  { keys: "mod+=", where: "canvas", action: "zoom-in" },
  { keys: "mod+shift+=", where: "canvas", action: "zoom-in" },
  { keys: "mod++", where: "canvas", action: "zoom-in" },
  { keys: "mod+-", where: "canvas", action: "zoom-out" },
  { keys: "mod+o", where: "canvas", action: "open-folder" },
  { keys: "mod+r", where: "canvas", action: "open-recent" },
  { keys: "mod+w", where: "canvas", action: "close-tile" },
  { keys: "ctrl+b", where: "canvas", action: "toggle-layers" },
  { keys: "escape", where: "canvas", action: "stop-arrow" },
  { keys: "escape", where: "canvas", action: "leave-fullscreen" },
  { keys: "escape", where: "canvas", action: "deselect" },
  { keys: "escape", where: "canvas", action: "fit-all" },
  { keys: "shift+escape", where: "canvas", action: "undock" },
  { keys: ".", where: "canvas", action: "focus-selected" },
  { keys: "1", where: "canvas", action: "new-terminal" },
  { keys: "2", where: "canvas", action: "agent" },
  { keys: "3", where: "canvas", action: "explorer" },
  { keys: "6", where: "canvas", action: "new-frame" },
  { keys: "7", where: "canvas", action: "new-browser" },
  { keys: "backspace", where: "canvas", action: "remove-selected" },
  { keys: "delete", where: "canvas", action: "remove-selected" },
  { keys: "f2", where: "canvas", action: "rename-frame" },

  { keys: "mod+c", where: "terminal", action: "copy" },
  { keys: "mod+shift+c", where: "terminal", action: "copy" },
  { keys: "shift+enter", where: "terminal", action: "new-line" },
  // A docked terminal has the keyboard: undocking it is the one key out. With no slot to leave, the
  // key is the program's.
  { keys: "shift+escape", where: "terminal", action: "undock" },
  { keys: "mod+shift+k", where: "terminal", action: "take-keyboard" },
  { keys: "mod+=", where: "terminal", action: "font-bigger" },
  { keys: "mod+shift+=", where: "terminal", action: "font-bigger" },
  { keys: "mod++", where: "terminal", action: "font-bigger" },
  { keys: "mod+-", where: "terminal", action: "font-smaller" },
  { keys: "mod+0", where: "terminal", action: "font-reset" },
];

/** Each row's chord, read once as the app starts: a row that does not read stops it there. */
const READ: ReadonlyArray<Binding & { chord: Chord }> = KEYMAP.map((b) => {
  const chord = readChord(b.keys);
  if (!chord) throw new Error(`keymap: "${b.keys}" (${b.action}) is not modifiers and one key`);
  return { ...b, chord };
});

/** The rows whose key is a sign (`-`, `=`, `+`, `,` …), not a letter, digit or named key. */
const SIGNED = READ.filter((b) => b.chord.key.length === 1 && !/^[a-z0-9]$/.test(b.chord.key));

/** What this key press does `where`, in the order to try them; none: it is the tile's.
 *
 *  A digit is matched by its place and a sign by what the layout types, so one press can be both:
 *  French Ctrl+6 types `-`. The sign wins, wherever its row is: that press sizes the text and zooms
 *  out, and tile 6 has no key on that layout. A digit key typing a sign no row names (AZERTY's
 *  Ctrl+1 typing `&`) is still the digit. */
export function actionsFor(press: KeyPress, where: Where, mac: boolean): Action[] {
  const sign = SIGNED.some((b) => pressIs(b.chord, press, mac));
  return READ.filter((b) => b.where === where && pressIs(b.chord, press, mac) && !(sign && /^[0-9]$/.test(b.chord.key)))
    .map((b) => b.action);
}

/** Whose key names a label uses. */
export type KeyOS = "mac" | "windows" | "linux";

const MAC_KEY: Record<string, string> = {
  escape: "Esc", enter: "Enter", tab: "Tab", space: "Space", backspace: "⌫", delete: "⌦", home: "Home", end: "End",
  pageup: "Page Up", pagedown: "Page Down", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
};
const PC_KEY: Record<string, string> = { ...MAC_KEY, backspace: "Backspace", delete: "Delete" };

/** A chord as this platform writes it: `mod+shift+a` is ⌘⇧A on a Mac and Ctrl+Shift+A elsewhere,
 *  where `meta` is the Super key (the Windows key on Windows). */
export function keysLabel(keys: string, os: KeyOS): string {
  const c = readChord(keys);
  if (!c) return keys;
  const mac = os === "mac";
  const key = (mac ? MAC_KEY : PC_KEY)[c.key] ?? c.key.toUpperCase();
  const ctrl = c.ctrl || (c.mod && !mac);
  const meta = c.meta || (c.mod && mac);
  // A Mac's own order (⌃⌥⇧⌘) and no separator; elsewhere words joined by "+".
  if (mac) return `${ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${meta ? "⌘" : ""}${key}`;
  return [meta && (os === "windows" ? "Win" : "Super"), ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", key].filter(Boolean).join("+");
}

/** Whether a key reaches the app on this platform. On Windows and Linux the system takes the keys
 *  held with Super (the Windows key) first, so they are not named there. */
export function reachesApp(keys: string, os: KeyOS): boolean {
  return os === "mac" || !readChord(keys)?.meta;
}

/** An action's keys as this platform writes them, the one to name first first: a key held with
 *  this platform's own modifier (⌘ on a Mac, Ctrl elsewhere) comes before one that is not. */
export function labelsOf(action: Action, os: KeyOS): string[] {
  const foreign = (c: Chord) => (os === "mac" ? c.ctrl : c.meta);
  const rows = READ.filter((b) => b.action === action && reachesApp(b.keys, os)).sort((a, b) => Number(foreign(a.chord)) - Number(foreign(b.chord)));
  return [...new Set(rows.map((b) => keysLabel(b.keys, os)))];
}
