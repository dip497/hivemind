// Which keys the canvas leaves to a focused control (useCanvasShortcuts.ts), in a real DOM
// (linkedom): Enter on a dialog's button presses the button, it does not enter a frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { document } = parseHTML(`<!doctype html><html><body>
  <div role="dialog"><button id="dialog-button">Keep them</button></div>
  <div role="menu"><div role="menuitem" id="menu-row">Rename</div></div>
  <div role="button" tabindex="0" id="layers-row">Frame</div>
  <select id="pick"><option>a</option></select>
  <div role="group" aria-label="Workspace tools"><button id="tool-button">Draw</button></div>
  <div class="react-flow__pane"><div class="react-flow__node" role="group" tabindex="0" id="node"></div></div>
</body></html>`);
const { keyIsTheControls } = await import("../../src/renderer/src/useCanvasShortcuts.ts");

test("a focused control keeps the keys it acts on; every other key, and every key on the canvas itself, is the canvas's", () => {
  const at = (id: string) => document.getElementById(id) as unknown as EventTarget;
  const rows: Array<[string, EventTarget | null, string, boolean]> = [
    ["Enter on a dialog's button presses it", at("dialog-button"), "Enter", true],
    ["any key in a dialog is the dialog's", at("dialog-button"), "Delete", true],
    ["a letter in a menu picks in it", at("menu-row"), "r", true],
    ["Enter on a Layers row opens that row", at("layers-row"), "Enter", true],
    ["Space on a button presses it", at("tool-button"), " ", true],
    ["an arrow on a select changes it", at("pick"), "ArrowDown", true],
    ["a tool letter on a clicked toolbar button is the canvas's", at("tool-button"), "v", false],
    ["Delete on a clicked toolbar button deletes the selection", at("tool-button"), "Delete", false],
    ["an arrow on a button nudges the selection", at("tool-button"), "ArrowLeft", false],
    ["Enter on a focused canvas node enters the frame", at("node"), "Enter", false],
    ["Enter with the page focused", document.body as unknown as EventTarget, "Enter", false],
    ["no target", null, "Enter", false],
  ];
  for (const [what, target, key, theirs] of rows) assert.equal(keyIsTheControls(target, key), theirs, what);
});
