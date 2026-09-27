import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityMeter, SAMPLE_MS, levelFor } from "../../src/main/pty-activity";

function meter() {
  const changes: Array<Record<string, number>> = [];
  let running = 0;
  const m = new ActivityMeter((c) => changes.push(c), { start: () => { running++; return 1 as never; }, stop: () => { running--; } });
  return { m, changes, running: () => running };
}
const perSample = (bytesPerSecond: number) => Math.round((bytesPerSecond * SAMPLE_MS) / 1000);

test("levels: quiet, trickle, steady, heavy", () => {
  assert.deepEqual([0, 31, 32, 1023, 1024, 16383, 16384, 1e6].map(levelFor), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test("the sampler runs only while something is watched, and unwatched output is ignored", () => {
  const h = meter();
  h.m.note("t1", 1e6);
  assert.equal(h.running(), 0);
  h.m.setWatched(["t1"]);
  assert.equal(h.running(), 1);
  h.m.sample();
  assert.deepEqual(h.changes, []); // bytes before watching were not counted
  h.m.setWatched([]);
  assert.equal(h.running(), 0);
});

test("a rise is reported at once; a drop only after it holds, so a pause does not flicker", () => {
  const h = meter();
  h.m.setWatched(["t1"]);
  h.m.note("t1", perSample(64 * 1024));
  h.m.sample();
  assert.deepEqual(h.changes, [{ t1: 3 }]);
  h.m.note("t1", perSample(64 * 1024));
  h.m.sample();
  h.m.sample(); // one quiet sample: still heavy-ish, nothing reported
  h.m.note("t1", perSample(64 * 1024));
  h.m.sample();
  assert.deepEqual(h.changes, [{ t1: 3 }]);
  for (let i = 0; i < 20; i++) h.m.sample();
  assert.deepEqual(h.changes.at(-1), { t1: 0 });
  assert.ok(h.changes.length <= 4, `changes: ${JSON.stringify(h.changes)}`);
});

test("only changed tiles are reported, in one batch per sample", () => {
  const h = meter();
  h.m.setWatched(["a", "b"]);
  h.m.note("a", perSample(2048));
  h.m.sample();
  assert.deepEqual(h.changes, [{ a: 2 }]);
  h.m.note("a", perSample(4096));
  h.m.note("b", perSample(4096));
  h.m.sample();
  assert.deepEqual(h.changes.at(-1), { b: 2 });
});
