import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptRemoteEvent } from "../../src/main/remote/events.ts";

const mine = (id: string) => id === "hm:mine";

test("events for this machine's own tiles pass; a transcript path on that machine is dropped", () => {
  assert.deepEqual(acceptRemoteEvent({ tileId: "hm:mine", state: "idle" }, mine), { tileId: "hm:mine", state: "idle" });
  assert.deepEqual(acceptRemoteEvent({ tileId: "hm:mine", transcriptPath: "/home/x/t.jsonl" }, mine), { tileId: "hm:mine", transcriptPath: null });
});

test("anything about another tile, or without a tile, is refused", () => {
  assert.equal(acceptRemoteEvent({ tileId: "hm:local-tile", state: "working" }, mine), null);
  assert.equal(acceptRemoteEvent({ state: "working" }, mine), null);
  assert.equal(acceptRemoteEvent({ tileId: 42 }, mine), null);
  assert.equal(acceptRemoteEvent(null, mine), null);
  assert.equal(acceptRemoteEvent("hm:mine", mine), null);
});
