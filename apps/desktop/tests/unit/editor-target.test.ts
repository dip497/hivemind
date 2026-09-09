/**
 * Regression: opening a file from a terminal must land in an editor of the
 * SAME frame, and when that frame has none the caller has to spawn one and
 * carry the path with it (Workspace.openFileFromTerminal used to spawn a bare
 * editor and drop the file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEditorTile } from "../../src/renderer/src/workspace/editor-target";
import type { TileInstance } from "../../src/renderer/src/canvas-persistence";

const tile = (id: string, kind: string): TileInstance => ({ id, kind, label: id } as TileInstance);

test("an editor in the source frame takes the file", () => {
  const tiles = [tile("tile-shell-1", "shell"), tile("tile-editor-1", "editor")];
  assert.equal(pickEditorTile(tiles, { "tile-shell-1": "f1", "tile-editor-1": "f1" }, "f1"), "tile-editor-1");
});

test("a workbench counts as an editor (it embeds one)", () => {
  const tiles = [tile("tile-workbench-1", "workbench")];
  assert.equal(pickEditorTile(tiles, { "tile-workbench-1": "f1" }, "f1"), "tile-workbench-1");
});

test("an editor in ANOTHER frame is not hijacked — the caller must spawn one", () => {
  const tiles = [tile("tile-editor-9", "editor")];
  assert.equal(pickEditorTile(tiles, { "tile-editor-9": "other" }, "f1"), null);
});

test("no editor anywhere → null (spawn, and the spawn carries the path)", () => {
  assert.equal(pickEditorTile([tile("tile-shell-1", "shell")], { "tile-shell-1": "f1" }, "f1"), null);
  assert.equal(pickEditorTile([], {}, null), null);
});

test("without a frame scope any editor will do (a loose tile)", () => {
  const tiles = [tile("tile-editor-1", "editor")];
  assert.equal(pickEditorTile(tiles, { "tile-editor-1": "f1" }, null), "tile-editor-1");
});
