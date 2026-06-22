// subagent-reaper — lost-edge watchdog for the in-flight subagent set.
import { test } from "node:test";
import assert from "node:assert/strict";

const { SubagentReaper } = await import("../../src/main/hcp/subagent-reaper.ts");

/** A controllable fake clock: timers fire only when tick() is called. */
function fakeClock() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    clock: {
      set: (cb: () => void) => { const id = ++seq; pending.set(id, cb); return id as unknown as ReturnType<typeof setTimeout>; },
      clear: (t: ReturnType<typeof setTimeout>) => { pending.delete(t as unknown as number); },
    },
    fireAll: () => { for (const [, cb] of [...pending]) cb(); },
    pendingCount: () => pending.size,
  };
}

test("reaps the tile after the grace window with no further edge", () => {
  const reaped: string[] = [];
  const { clock, fireAll } = fakeClock();
  const r = new SubagentReaper(1000, (id) => reaped.push(id), clock);
  r.arm("t1");
  assert.equal(r.armed("t1"), true);
  fireAll();
  assert.deepEqual(reaped, ["t1"]);
  assert.equal(r.armed("t1"), false); // timer cleared itself on fire
});

test("re-arming replaces the prior timer (no double reap)", () => {
  const reaped: string[] = [];
  const { clock, fireAll, pendingCount } = fakeClock();
  const r = new SubagentReaper(1000, (id) => reaped.push(id), clock);
  r.arm("t1");
  r.arm("t1"); // an active population keeps pushing the deadline out
  r.arm("t1");
  assert.equal(pendingCount(), 1); // only ONE live timer, not three
  fireAll();
  assert.deepEqual(reaped, ["t1"]); // reaped exactly once
});

test("cancel prevents the reap (set drained naturally / tile closed)", () => {
  const reaped: string[] = [];
  const { clock, fireAll } = fakeClock();
  const r = new SubagentReaper(1000, (id) => reaped.push(id), clock);
  r.arm("t1");
  r.cancel("t1");
  assert.equal(r.armed("t1"), false);
  fireAll();
  assert.deepEqual(reaped, []);
});

test("tracks tiles independently", () => {
  const reaped: string[] = [];
  const { clock, fireAll } = fakeClock();
  const r = new SubagentReaper(1000, (id) => reaped.push(id), clock);
  r.arm("a");
  r.arm("b");
  r.cancel("a");
  fireAll();
  assert.deepEqual(reaped, ["b"]);
});
