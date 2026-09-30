import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAgentTile, unregisterAgentTile, latestAgentTile, shouldDeliver } from "../../src/renderer/src/agent-send.ts";
import { queueWork, claimWork, clearWork } from "../../src/renderer/src/work-queue.ts";

test("latest resolves to most-recently-registered", () => {
  registerAgentTile("a");
  registerAgentTile("b");
  assert.equal(latestAgentTile(), "b");
  registerAgentTile("a"); // re-register moves to latest
  assert.equal(latestAgentTile(), "a");
  unregisterAgentTile("a");
  assert.equal(latestAgentTile(), "b");
  unregisterAgentTile("b");
});

test("bare string send delivers ONLY to the latest tile", () => {
  registerAgentTile("a");
  registerAgentTile("b");
  assert.equal(shouldDeliver("b", "hello").deliver, true);
  assert.equal(shouldDeliver("a", "hello").deliver, false); // the bug we fixed
  unregisterAgentTile("a"); unregisterAgentTile("b");
});

test("target 'all' broadcasts; specific tileId targets one", () => {
  registerAgentTile("a");
  registerAgentTile("b");
  assert.equal(shouldDeliver("a", { text: "x", target: "all" }).deliver, true);
  assert.equal(shouldDeliver("b", { text: "x", target: "all" }).deliver, true);
  assert.equal(shouldDeliver("a", { text: "x", target: "a" }).deliver, true);
  assert.equal(shouldDeliver("b", { text: "x", target: "a" }).deliver, false);
  unregisterAgentTile("a"); unregisterAgentTile("b");
});

test("empty text never delivers", () => {
  registerAgentTile("a");
  assert.equal(shouldDeliver("a", { text: "", target: "all" }).deliver, false);
  unregisterAgentTile("a");
});

test("work prompt is queued against a tile id and claimed once by that tile", () => {
  queueWork("tile-1", "Work on PAY-3");
  // a DIFFERENT tile never steals it
  assert.equal(claimWork("tile-2"), undefined);
  // the right tile claims it
  assert.equal(claimWork("tile-1"), "Work on PAY-3");
  // one-shot: a second claim gets nothing (no double-send)
  assert.equal(claimWork("tile-1"), undefined);
});

test("empty work is not queued; clearWork drops a pending prompt", () => {
  queueWork("tile-3", "");
  assert.equal(claimWork("tile-3"), undefined);
  queueWork("tile-4", "do it");
  clearWork("tile-4");
  assert.equal(claimWork("tile-4"), undefined);
});
