import { test } from "node:test";
import assert from "node:assert/strict";
import { mintId } from "../src/tile-id.ts";

test("ids minted in the same millisecond stay distinct", () => {
  const ids = Array.from({ length: 50 }, () => mintId("tile-pi"));
  assert.equal(new Set(ids).size, ids.length);
  assert.match(ids[0]!, /^tile-pi-\d+$/);
});
