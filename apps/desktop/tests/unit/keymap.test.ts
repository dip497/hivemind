import { test } from "node:test";
import assert from "node:assert/strict";
import { actionsFor, type Where } from "../../src/shared/keymap";

type Mods = Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }>;
/** A key press as the browser reports it: `key` is what the layout types, `code` the key's place. */
const press = (key: string, code: string, m: Mods = {}) =>
  ({ key, code, ctrlKey: !!m.ctrl, metaKey: !!m.meta, shiftKey: !!m.shift, altKey: !!m.alt });
const on = (where: Where, key: string, code: string, m: Mods = {}, mac = false) => actionsFor(press(key, code, m), where, mac);
const letter = (k: string, m: Mods = {}) => press(m.shift ? k.toUpperCase() : k, `Key${k.toUpperCase()}`, m);

test("the app's keys are taken from a terminal too", () => {
  assert.deepEqual(on("anywhere", "~", "Backquote", { ctrl: true, shift: true }), ["new-terminal"], "Shift+` reports its shifted key");
  assert.deepEqual(actionsFor(letter("e", { ctrl: true, shift: true }), "anywhere", false), ["explorer"]);
  assert.deepEqual(actionsFor(letter("a", { ctrl: true, shift: true }), "anywhere", false), ["agent"]);
  assert.deepEqual(on("anywhere", "Tab", "Tab", { ctrl: true }), ["next-tile"]);
  assert.deepEqual(on("anywhere", "Tab", "Tab", { ctrl: true, shift: true }), ["prev-tile"]);
  assert.deepEqual(on("anywhere", "9", "Digit9", { ctrl: true }), ["tile:9"]);
  assert.deepEqual(on("anywhere", ")", "Digit0", { ctrl: true, shift: true }), ["reset-scale"]);
  assert.deepEqual(actionsFor(letter("f", { ctrl: true, shift: true }), "anywhere", false), ["fit-to-screen"]);
});

test("the shell keeps its Ctrl+letter keys, and Alt or no modifier is never the app's", () => {
  for (const k of "lwdbtecroukqz") assert.deepEqual(actionsFor(letter(k, { ctrl: true }), "anywhere", true), [], `Ctrl+${k} on a Mac`);
  for (const k of "lwdbtecrouk") assert.deepEqual(actionsFor(letter(k, { ctrl: true }), "anywhere", false), [], `Ctrl+${k}`);
  assert.deepEqual(actionsFor(letter("e", { ctrl: true, shift: true, alt: true }), "anywhere", false), []);
  assert.deepEqual(on("anywhere", "1", "Digit1"), []);
});

test("⌘ is the app's modifier on a Mac, Ctrl elsewhere", () => {
  assert.deepEqual(actionsFor(letter("q", { meta: true }), "anywhere", true), ["quit"]);
  assert.deepEqual(actionsFor(letter("q", { ctrl: true }), "anywhere", false), ["quit"]);
  assert.deepEqual(actionsFor(letter("q", { meta: true }), "anywhere", false), []);
  assert.deepEqual(actionsFor(letter("b", { meta: true }), "anywhere", true), ["toggle-layers"]);
  assert.deepEqual(on("anywhere", "2", "Digit2", { meta: true }, true), ["tile:2"]);
});

test("Esc on the canvas is tried in order, and Shift+Esc only undocks", () => {
  assert.deepEqual(on("canvas", "Escape", "Escape"), ["stop-arrow", "leave-fullscreen", "deselect", "fit-all"]);
  assert.deepEqual(on("canvas", "Escape", "Escape", { shift: true }), ["undock"]);
  assert.deepEqual(on("anywhere", "Escape", "Escape"), [], "a terminal's program keeps Esc");
});

test("the same key is the canvas's zoom and the terminal's font", () => {
  assert.deepEqual(on("canvas", "=", "Equal", { ctrl: true }), ["zoom-in"]);
  assert.deepEqual(on("terminal", "=", "Equal", { ctrl: true }), ["font-bigger"]);
  assert.deepEqual(on("terminal", "-", "Minus", { ctrl: true }), ["font-smaller"]);
  assert.deepEqual(on("terminal", "_", "Minus", { ctrl: true, shift: true }), [], "Ctrl+_ is undo in a shell's and an agent's prompt");
  assert.deepEqual(actionsFor(letter("c", { ctrl: true }), "terminal", false), ["copy"]);
  assert.deepEqual(actionsFor(letter("c", { ctrl: true, shift: true }), "terminal", false), ["copy"]);
  assert.deepEqual(actionsFor(letter("r", { ctrl: true }), "terminal", false), [], "Ctrl+R is the shell's history search");
});

test("a letter is the one the layout types, its place only when the layout types no Latin letter", () => {
  // Dvorak: the key typing "c" sits where QWERTY has I; the one at QWERTY's C types "j".
  assert.deepEqual(on("terminal", "c", "KeyI", { ctrl: true }), ["copy"]);
  assert.deepEqual(on("terminal", "j", "KeyC", { ctrl: true }), []);
  // Russian: the key at C types "с", and Ctrl+C still copies.
  assert.deepEqual(on("terminal", "с", "KeyC", { ctrl: true }), ["copy"]);
});

test("a number pad key is a digit only while Num Lock makes it type one", () => {
  // Num Lock off: the pad's 1, 2, 4, 7 and 0 are End, ArrowDown, ArrowLeft, Home and Insert.
  const off: [string, string][] = [["End", "Numpad1"], ["ArrowDown", "Numpad2"], ["ArrowLeft", "Numpad4"], ["Home", "Numpad7"], ["Insert", "Numpad0"]];
  for (const where of ["anywhere", "terminal", "canvas"] as const) {
    for (const [key, code] of off) {
      for (const ctrl of [false, true]) assert.deepEqual(on(where, key, code, { ctrl }), [], `${ctrl ? "Ctrl+" : ""}${key} on ${code} at ${where}`);
    }
  }
  // Num Lock on: the digit, as the top row's.
  assert.deepEqual(on("anywhere", "1", "Numpad1", { ctrl: true }), ["tile:1"]);
  assert.deepEqual(on("canvas", "2", "Numpad2"), ["agent"]);
  assert.deepEqual(on("terminal", "0", "Numpad0", { ctrl: true }), ["font-reset"]);
});

test("a digit key that types a sign a row names is that sign: French Ctrl+6 sizes text, not tile 6", () => {
  // French AZERTY: the 6 key types "-" unshifted.
  assert.deepEqual(on("anywhere", "-", "Digit6", { ctrl: true }), []);
  assert.deepEqual(on("terminal", "-", "Digit6", { ctrl: true }), ["font-smaller"]);
  assert.deepEqual(on("canvas", "-", "Digit6", { ctrl: true }), ["zoom-out"]);
  // Signs no row names stay digits: AZERTY's Ctrl+1, 3, 4 and 5 type & " ' ( and go to tiles.
  for (const [key, n] of [["&", 1], ["\"", 3], ["'", 4], ["(", 5]] as const) {
    assert.deepEqual(on("anywhere", key, `Digit${n}`, { ctrl: true }), [`tile:${n}`], `${key} on Digit${n}`);
  }
  // Without ctrl no row names "-", so the canvas's bare 6 key still makes a frame.
  assert.deepEqual(on("canvas", "-", "Digit6"), ["new-frame"]);
  // A US 6 is tile 6.
  assert.deepEqual(on("anywhere", "6", "Digit6", { ctrl: true }), ["tile:6"]);
});
