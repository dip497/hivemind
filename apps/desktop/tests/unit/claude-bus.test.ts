import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClaude, unregisterClaude, latestClaude, shouldDeliver, queueWork, claimWork, clearWork } from "../../src/renderer/src/claude-bus.ts";

test("latest resolves to most-recently-registered", () => {
  registerClaude("a");
  registerClaude("b");
  assert.equal(latestClaude(), "b");
  registerClaude("a"); // re-register moves to latest
  assert.equal(latestClaude(), "a");
  unregisterClaude("a");
  assert.equal(latestClaude(), "b");
  unregisterClaude("b");
});

test("bare string send delivers ONLY to the latest tile", () => {
  registerClaude("a");
  registerClaude("b");
  assert.equal(shouldDeliver("b", "hello").deliver, true);
  assert.equal(shouldDeliver("a", "hello").deliver, false); // the bug we fixed
  unregisterClaude("a"); unregisterClaude("b");
});

test("target 'all' broadcasts; specific tileId targets one", () => {
  registerClaude("a");
  registerClaude("b");
  assert.equal(shouldDeliver("a", { text: "x", target: "all" }).deliver, true);
  assert.equal(shouldDeliver("b", { text: "x", target: "all" }).deliver, true);
  assert.equal(shouldDeliver("a", { text: "x", target: "a" }).deliver, true);
  assert.equal(shouldDeliver("b", { text: "x", target: "a" }).deliver, false);
  unregisterClaude("a"); unregisterClaude("b");
});

test("empty text never delivers", () => {
  registerClaude("a");
  assert.equal(shouldDeliver("a", { text: "", target: "all" }).deliver, false);
  unregisterClaude("a");
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
