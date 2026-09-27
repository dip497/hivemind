import { test } from "node:test";
import assert from "node:assert/strict";
import { AWAY_AFTER_S, IDLE_AFTER_S, PresenceMonitor, localDay } from "../../src/main/presence";

function harness(start = new Date(2026, 8, 23, 10, 0, 0).getTime()) {
  let clock = start;
  let idle = 0;
  let focused = true;
  const changes: string[] = [];
  const m = new PresenceMonitor({
    idleSeconds: () => idle, focused: () => focused, now: () => clock, dayOf: localDay,
    onChange: (p) => changes.push(`${p.state}${p.focused ? "" : ":blur"}`),
  });
  return { m, changes, set: (s: number) => { idle = s; }, blur: (b: boolean) => { focused = !b; }, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test("thresholds: active, idle after 2 min, away after 10 min, and back", () => {
  const h = harness();
  assert.equal(h.m.current.state, "active");
  h.set(IDLE_AFTER_S); h.m.evaluate();
  h.set(AWAY_AFTER_S); h.m.evaluate();
  h.set(0); h.m.evaluate();
  assert.deepEqual(h.changes, ["idle", "away", "active"]);
});

test("lock is away at once; focus is reported without resetting since", () => {
  const h = harness();
  const since = h.m.current.since;
  h.tick(1000);
  h.blur(true); h.m.evaluate();
  assert.equal(h.m.current.since, since);
  h.m.setLocked(true);
  assert.equal(h.m.current.state, "away");
  h.m.setLocked(false);
  assert.deepEqual(h.changes, ["active:blur", "away:blur", "active:blur"]);
});

test("totals: seconds per state, split at local midnight, and no times kept", () => {
  const h = harness(new Date(2026, 8, 23, 23, 59, 0).getTime());
  h.tick(30_000);
  h.set(AWAY_AFTER_S); h.m.evaluate(); // 30 s active on the 23rd, then away
  h.tick(60_000); h.m.evaluate();      // 30 s away on the 23rd, 30 s on the 24th
  assert.deepEqual(h.m.totalsFor("2026-09-23"), { active: 30, idle: 0, away: 30 });
  assert.deepEqual(h.m.totalsFor("2026-09-24"), { active: 0, idle: 0, away: 30 });
});
