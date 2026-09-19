import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSpawnPacer } from "../../src/main/spawn-pacer.js";

test("a burst past the limit waits for room instead of failing", async () => {
  const acquire = makeSpawnPacer({ windowMs: 120, max: 2, queueMax: 10 });
  const t0 = Date.now();
  await Promise.all([acquire(), acquire(), acquire(), acquire()]);
  // Two go at once, the other two only after the first window rolls over.
  assert.ok(Date.now() - t0 >= 110, "spawns past the limit were paced, not rejected");
});

test("a backlog past queueMax is refused — the runaway case", async () => {
  const acquire = makeSpawnPacer({ windowMs: 5_000, max: 1, queueMax: 2 });
  await acquire();                       // uses the only slot
  const held = [acquire(), acquire()];   // two wait
  await assert.rejects(acquire(), /rate limit exceeded/);
  void held;
});
