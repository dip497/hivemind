import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOrdinal } from "../../src/renderer/src/useSpawn";

test("nextOrdinal: one past the highest of this label, pending labels included", () => {
  const f = (n: number) => `claude #${n}`;
  assert.equal(nextOrdinal([], f), 1);
  assert.equal(nextOrdinal(["claude #1", "shell #7", "claude #3 (plan)"], f), 4);
  // Two spawns in one tick: the first's label is pending, not yet on the canvas.
  const pending = ["claude #1"];
  assert.equal(nextOrdinal(["claude #1", ...pending.slice(1)], f), 2);
  assert.equal(nextOrdinal(["Pi #2", "Pi #3"], (n) => `Pi #${n}`), 4);
});
