import { test } from "node:test";
import assert from "node:assert/strict";
import { appKeyMessage, appShortcut, isQuitKey, menuKey } from "../../src/shared/shortcuts";

const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) =>
  appShortcut({ key: k, control: false, meta: false, shift: false, alt: false, ...mods });
const ctrl = (k: string, shift = false) => key(k, { control: true, shift });

test("VS Code's app keys map to actions", () => {
  assert.equal(ctrl("~", true), "new-terminal"); // Shift+` reports its shifted key
  assert.equal(ctrl("`", true), "new-terminal");
  assert.equal(ctrl("E", true), "explorer");
  assert.equal(ctrl("G", true), null, "the Code tile's Changes replaced the Diff tile and its key");
  assert.equal(ctrl("A", true), "agent");
  assert.equal(ctrl("N", true), "new-frame");
  assert.equal(ctrl("Tab"), "next-tile");
  assert.equal(ctrl("Tab", true), "prev-tile");
  assert.equal(ctrl("1"), "tile:1");
  assert.equal(ctrl("9"), "tile:9");
  assert.equal(ctrl(","), "settings");
});

test("⌘ works where Ctrl does", () => {
  assert.equal(key("E", { meta: true, shift: true }), "explorer");
  assert.equal(key("2", { meta: true }), "tile:2");
});

// Everything else belongs to the focused tile — these are the shell's.
test("the shell keeps its Ctrl+letter keys", () => {
  for (const k of ["l", "w", "d", "b", "t", "e", "a", "c", "r", "o", "u", "k", "\\"]) assert.equal(ctrl(k), null, `Ctrl+${k}`);
});

test("no modifier, Alt, or Ctrl+0 is not an app shortcut", () => {
  assert.equal(key("1"), null);          // the canvas's own number keys
  assert.equal(key("E", { shift: true }), null);
  assert.equal(key("E", { control: true, shift: true, alt: true }), null);
  assert.equal(ctrl("0"), null);         // canvas zoom, or the tile's font — decided in the renderer
});

test("Ctrl+B and Ctrl+N stay with the terminal; ⌘B is the app's, ⌘N is not", () => {
  const base = { control: false, meta: false, shift: false, alt: false };
  assert.equal(menuKey({ ...base, key: "b", control: true }), null);
  assert.equal(menuKey({ ...base, key: "n", control: true }), null);
  assert.equal(menuKey({ ...base, key: "b", meta: true }), "toggle-layers");
  assert.equal(menuKey({ ...base, key: "N", meta: true }), null);
  assert.equal(menuKey({ ...base, key: "b", meta: true, shift: true }), null);
});

test("each app key is one message to the page, the same from main and in a browser tab", () => {
  const msg = (k: string, mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }>) =>
    appKeyMessage({ key: k, control: false, meta: false, shift: false, alt: false, ...mods });
  assert.deepEqual(msg("E", { control: true, shift: true }), ["menu:shortcut", "explorer"]);
  assert.deepEqual(msg("F", { control: true, shift: true }), ["menu:fit-overlay"]);
  assert.deepEqual(msg(")", { control: true, shift: true }), ["menu:reset-scale"]);
  assert.deepEqual(msg("0", { meta: true, shift: true }), ["menu:reset-scale"]);
  assert.deepEqual(msg(".", { control: true }), ["menu:focus-tile"]);
  assert.deepEqual(msg("b", { meta: true }), ["menu:toggle-layers"]);
  assert.equal(msg("X", { control: true, shift: true }), null);
  assert.equal(msg(".", { control: true, shift: true }), null);
  assert.equal(msg("b", { control: true }), null);
  assert.equal(msg("F", { control: true, shift: true, alt: true }), null);
});

test("Quit is ⌘Q on macOS and Ctrl+Q elsewhere, and no other Q", () => {
  const q = (mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }>, platform: string, k = "q") =>
    isQuitKey({ key: k, control: false, meta: false, shift: false, alt: false, ...mods }, platform);
  assert.equal(q({ control: true }, "linux"), true);
  assert.equal(q({ control: true }, "win32", "Q"), true);
  assert.equal(q({ meta: true }, "darwin"), true);
  assert.equal(q({ control: true }, "darwin"), false, "Ctrl+Q stays with a terminal on a Mac");
  assert.equal(q({ meta: true }, "linux"), false);
  assert.equal(q({ control: true, shift: true }, "linux"), false);
  assert.equal(q({ control: true, alt: true }, "linux"), false);
  assert.equal(q({}, "linux"), false);
});
