// A task is claimed once, however many copies of this module the window ends up with:
// a tile's body mounts twice in development, and a hot reload brings a second copy with it.
import { test } from "node:test";
import assert from "node:assert/strict";

const path = "../../src/renderer/src/work-queue.ts";
const first = await import(path);
// A second copy of the same module, as a hot reload produces.
const second = await import(`${path}?copy=2`);

test("two copies of the bus share one queue, so a task is delivered once", () => {
  first.queueWork("tile-1", "do the thing");
  assert.equal(second.claimWork("tile-1"), "do the thing");
  assert.equal(first.claimWork("tile-1"), undefined, "the other copy has nothing left to deliver");
});

test("a claim is one-shot, and a tile that never asks keeps its task until it is cleared", () => {
  first.queueWork("tile-2", "later");
  assert.equal(first.peekWork("tile-2"), "later");
  first.clearWork("tile-2");
  assert.equal(first.peekWork("tile-2"), undefined);
});
