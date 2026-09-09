import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWebglSlotClient, unregisterWebglSlotClient, reconcileWebglSlots, type WebglSlotClient } from "../../src/renderer/src/webgl-slots";
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("a surface commit reads each client's final priority once", async () => {
  let reads = 0, acquired = 0, released = 0, priority = 1;
  const clients: WebglSlotClient[] = Array.from({ length: 8 }, (_, i) => ({
    id: `batch-${i}`, priority: () => { reads++; return priority; },
    acquire: () => { acquired++; }, release: () => { released++; },
  }));
  try {
    clients.forEach(registerWebglSlotClient);
    for (let i = 0; i < 8; i++) reconcileWebglSlots();
    priority = 0;
    assert.equal(reads, 0);
    await flush();
    assert.equal(reads, 8);
    assert.equal(acquired, 0);
    priority = 1;
    for (let i = 0; i < 8; i++) reconcileWebglSlots();
    await flush();
    assert.equal(reads, 16);
    assert.equal(acquired, 8);
    priority = 0;
    reconcileWebglSlots();
    priority = 1;
    reconcileWebglSlots();
    await flush();
    assert.equal(acquired, 8);
    assert.equal(released, 0);
  } finally {
    clients.forEach((c) => unregisterWebglSlotClient(c.id));
    await flush();
  }
  assert.equal(released, 8);
});

test("a terminal removed before the queued pass never acquires a context", async () => {
  let acquired = 0;
  registerWebglSlotClient({ id: "removed", priority: () => 1, acquire: () => { acquired++; }, release: () => {} });
  unregisterWebglSlotClient("removed");
  await flush();
  assert.equal(acquired, 0);
});

test("budget replacement releases before acquiring and DOM opt-in frees its slot", async () => {
  let active = 0, peak = 0, focused = false, dom = false;
  const events: string[] = [];
  const clients: WebglSlotClient[] = Array.from({ length: 13 }, (_, i) => ({
    id: `budget-${i}`, priority: () => i === 0 ? (focused ? 2 : 0) : 1,
    wantsDom: () => i === 0 && dom,
    acquire: () => { active++; peak = Math.max(peak, active); events.push(`+${i}`); },
    release: () => { active--; events.push(`-${i}`); },
  }));
  try {
    clients.forEach(registerWebglSlotClient);
    await flush();
    assert.equal(active, 12);
    events.length = 0;
    focused = true;
    reconcileWebglSlots();
    await flush();
    assert.deepEqual(events, ["-12", "+0"]);
    assert.equal(peak, 12);
    dom = true;
    reconcileWebglSlots();
    await flush();
    assert.equal(clients[0]._hasSlot, false);
    assert.equal(active, 12);
    unregisterWebglSlotClient(clients[1].id);
    assert.equal(active, 11, "unmount releases synchronously");
  } finally {
    clients.forEach((c) => unregisterWebglSlotClient(c.id));
    await flush();
  }
  assert.equal(active, 0);
});
