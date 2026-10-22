/** Every key the app answers, and where: the one list main, the window and a browser tab on the app
 *  read. A key not listed is the focused tile's, a terminal's program first of all.
 *
 *  - `anywhere`: taken before the focused tile sees it, from a terminal too. Only keys a terminal
 *    program has no use for, or that move you out of it: VS Code keeps the same few.
 *  - `canvas`: only while nothing is being typed into; in a terminal or a field the key is theirs.
 *  - `terminal`: the focused terminal's own: copy, its font, taking back the keyboard.
 *
 *  Keys that share a chord are tried in order: an action that has nothing to do (no selection, no
 *  arrow being drawn) leaves the key to the next, and the last to the program. */
import { type Chord, type KeyPress, pressIs, readChord } from "@hivemind/view-sdk/commands";

export type Where = "anywhere" | "canvas" | "terminal";

export interface Binding {
  /** `mod` is Cmd on a Mac, Ctrl elsewhere. */
  keys: string;
  where: Where;
  action: string;
}

const tiles = Array.from({ length: 9 }, (_, i) => ({ keys: `mod+${i + 1}`, where: "anywhere", action: `tile:${i + 1}` }) as const);

export const KEYMAP: readonly Binding[] = [
  { keys: "mod+q", where: "anywhere", action: "quit" },
  { keys: "f11", where: "anywhere", action: "window-fullscreen" },
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
  { keys: "mod+shift+k", where: "terminal", action: "take-keyboard" },
  { keys: "mod+=", where: "terminal", action: "font-bigger" },
  { keys: "mod+shift+=", where: "terminal", action: "font-bigger" },
  { keys: "mod++", where: "terminal", action: "font-bigger" },
  { keys: "mod+-", where: "terminal", action: "font-smaller" },
  { keys: "mod+shift+-", where: "terminal", action: "font-smaller" },
  { keys: "mod+0", where: "terminal", action: "font-reset" },
];

/** Each row's chord, read once as the app starts: a row that does not read stops it there. */
const READ: ReadonlyArray<Binding & { chord: Chord }> = KEYMAP.map((b) => {
  const chord = readChord(b.keys);
  if (!chord) throw new Error(`keymap: "${b.keys}" (${b.action}) is not modifiers and one key`);
  return { ...b, chord };
});

/** What this key press does `where`, in the order to try them; none: it is the tile's. */
export function actionsFor(press: KeyPress, where: Where, mac: boolean): string[] {
  return READ.filter((b) => b.where === where && pressIs(b.chord, press, mac)).map((b) => b.action);
}
