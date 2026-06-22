// worker-tiles — the background-worker marker registry (workflow / report:false
// tiles that must not steal focus or raise per-worker finished notifications).
import { test } from "node:test";
import assert from "node:assert/strict";

const { markBackgroundTile, unmarkBackgroundTile, isBackgroundTile } = await import(
  "../../src/renderer/src/worker-tiles.ts"
);

test("mark / is / unmark round-trip", () => {
  const id = "tile-claude-bg-1";
  assert.equal(isBackgroundTile(id), false);
  markBackgroundTile(id);
  assert.equal(isBackgroundTile(id), true);
  unmarkBackgroundTile(id);
  assert.equal(isBackgroundTile(id), false);
});

test("tiles are tracked independently; unmarking one leaves others", () => {
  markBackgroundTile("a");
  markBackgroundTile("b");
  unmarkBackgroundTile("a");
  assert.equal(isBackgroundTile("a"), false);
  assert.equal(isBackgroundTile("b"), true);
  unmarkBackgroundTile("b");
});

test("unmarking an unknown id is a no-op (never throws)", () => {
  assert.doesNotThrow(() => unmarkBackgroundTile("never-seen"));
  assert.equal(isBackgroundTile("never-seen"), false);
});
