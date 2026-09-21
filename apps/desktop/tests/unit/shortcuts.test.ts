import { test } from "node:test";
import assert from "node:assert/strict";
import { appShortcut } from "../../src/main/shortcuts";

const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) =>
  appShortcut({ key: k, control: false, meta: false, shift: false, alt: false, ...mods });
const ctrl = (k: string, shift = false) => key(k, { control: true, shift });

test("VS Code's app keys map to actions", () => {
  assert.equal(ctrl("~", true), "new-terminal"); // Shift+` reports its shifted key
  assert.equal(ctrl("`", true), "new-terminal");
  assert.equal(ctrl("E", true), "explorer");
  assert.equal(ctrl("G", true), "diff");
  assert.equal(ctrl("A", true), "agent");
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
  for (const k of ["l", "w", "d", "b", "t", "e", "a", "c", "r", "u", "k", "\\"]) assert.equal(ctrl(k), null, `Ctrl+${k}`);
});

test("no modifier, Alt, or Ctrl+0 is not an app shortcut", () => {
  assert.equal(key("1"), null);          // the canvas's own number keys
  assert.equal(key("E", { shift: true }), null);
  assert.equal(key("E", { control: true, shift: true, alt: true }), null);
  assert.equal(ctrl("0"), null);         // canvas zoom, or the tile's font — decided in the renderer
});
