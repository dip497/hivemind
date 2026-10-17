/** What a plugin lets an agent do with it: commands its manifest declares and its code answers
 *  (`hm.onCommand`). An agent lists them with `hive ctl plugin commands` and runs one with
 *  `hive ctl plugin call`, while the plugin is running: the active view, an open tool tile, a
 *  widget on the board. */
export interface PluginCommand {
  name: string;
  /** What it does, for the agent deciding whether to run it. */
  description: string;
  /** What its JSON argument holds, in a line: `{ "text": string }`. Absent: it takes none. */
  args?: string;
  /** The keys that run it (`mod+shift+k`, `mod+alt+arrowleft`): while focus is in the plugin, and
   *  for the active view anywhere in the app, a terminal too. `mod` is Cmd on a Mac, Ctrl elsewhere. */
  keys?: string;
}

export const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const COMMANDS_MAX = 32;

/** A manifest's `commands`, or why they are not. */
export function parsePluginCommands(raw: unknown): { commands: PluginCommand[] } | { error: string } {
  if (raw === undefined) return { commands: [] };
  if (!Array.isArray(raw) || raw.length > COMMANDS_MAX) return { error: `"commands" must be a list of at most ${COMMANDS_MAX}` };
  const commands: PluginCommand[] = [];
  for (const c of raw) {
    const o = (c ?? {}) as Record<string, unknown>;
    if (typeof o.name !== "string" || !COMMAND_NAME_RE.test(o.name)) return { error: `a command's "name" is lowercase letters, digits and dashes (got ${JSON.stringify(o.name)})` };
    if (commands.some((x) => x.name === o.name)) return { error: `command "${o.name}" is listed twice` };
    if (typeof o.description !== "string" || !o.description.trim() || o.description.length > 300) return { error: `command "${o.name}" needs a "description" of at most 300 characters` };
    if (o.args !== undefined && (typeof o.args !== "string" || o.args.length > 300)) return { error: `command "${o.name}": "args" is one line saying what its JSON argument holds` };
    if (o.keys !== undefined && (typeof o.keys !== "string" || !parseChord(o.keys))) {
      return { error: `command "${o.name}": "keys" is mod, ctrl or meta, other modifiers, and one key the terminals and the app leave free, as "mod+alt+k" or "mod+\\" (see the extension guide)` };
    }
    if (typeof o.keys === "string" && commands.some((x) => x.keys && sameChord(x.keys, o.keys as string))) return { error: `keys "${o.keys}" are given twice` };
    commands.push({ name: o.name, description: o.description.trim(), ...(typeof o.args === "string" ? { args: o.args } : {}), ...(typeof o.keys === "string" ? { keys: o.keys } : {}) });
  }
  return { commands };
}

interface Chord { mod: boolean; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; key: string }

/** The physical key a printable character names, so `shift` does not change what it is. */
const CODE: Record<string, string> = {
  "\\": "Backslash", "/": "Slash", "[": "BracketLeft", "]": "BracketRight", ",": "Comma", ".": "Period",
  ";": "Semicolon", "'": "Quote", "`": "Backquote", "-": "Minus", "=": "Equal",
};
const NAMED = new Set(["enter", "escape", "tab", "space", "backspace", "delete", "home", "end", "pageup", "pagedown",
  "arrowleft", "arrowright", "arrowup", "arrowdown", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);

/** Keys a terminal or the app answers with these modifiers: cursor moves, edits, zoom, a shell's
 *  control characters (Ctrl+[ is Escape, Ctrl+/ is undo). Adding alt frees them. */
const KEPT = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "pageup", "pagedown", "backspace",
  "delete", "space", "f11", "[", "/", "=", "-", "+", "_", ".", ","]);

/** A key a plugin may never take from the terminals or from the app: without mod, ctrl or meta it
 *  is typing (alt alone is a shell's meta key); escape and tab always; with mod and no alt, a
 *  letter or digit (Ctrl+C, Ctrl+Shift+V, the app's shortcuts), the keys above, and enter without shift. */
function kept(c: Chord): boolean {
  if (!(c.mod || c.ctrl || c.meta) || c.key === "escape" || c.key === "tab") return true;
  if (c.alt) return false;
  return /^[a-z0-9]$/.test(c.key) || KEPT.has(c.key) || (c.key === "enter" && !c.shift);
}

/** `mod+shift+k` read, or null when it is not modifiers and one key, or is a key the terminals and
 *  the app keep (`kept`). */
export function parseChord(raw: string): Chord | null {
  const parts = raw.toLowerCase().split("+");
  // `+` itself is the key when the chord ends in it: "mod++".
  if (raw.endsWith("++")) { parts.splice(-2, 2, "+"); }
  const c: Chord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    if (p === "mod" || p === "ctrl" || p === "meta" || p === "alt" || p === "shift") {
      if (c[p]) return null;
      c[p] = true;
    } else if (!c.key && (p.length === 1 || NAMED.has(p))) c.key = p;
    else return null;
  }
  return c.key && !kept(c) ? c : null;
}

function sameChord(a: string, b: string): boolean {
  const x = parseChord(a), y = parseChord(b);
  return !!x && !!y && JSON.stringify(x) === JSON.stringify(y);
}

/** The fields of a key event a chord is matched against. */
export interface KeyPress { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** Whether this key press is the chord. `mac`: `mod` is Cmd, otherwise Ctrl. */
export function chordMatches(chord: string, e: KeyPress, mac: boolean): boolean {
  const c = parseChord(chord);
  if (!c) return false;
  const ctrl = c.ctrl || (c.mod && !mac);
  const meta = c.meta || (c.mod && mac);
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  if (NAMED.has(c.key)) return c.key === "space" ? e.code === "Space" : e.key.toLowerCase() === c.key;
  if (/^[a-z]$/.test(c.key)) return e.code === `Key${c.key.toUpperCase()}`;
  if (/^[0-9]$/.test(c.key)) return e.code === `Digit${c.key}`;
  return CODE[c.key] ? e.code === CODE[c.key] : e.key === c.key;
}
