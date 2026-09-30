import { test } from "node:test";
import assert from "node:assert/strict";
import { GONE_MACHINE, frameMachine } from "../../src/renderer/src/machines/store";
import type { MachinesSnapshot } from "../../src/shared/ipc";

const snap = (over: Partial<MachinesSnapshot> = {}): MachinesSnapshot => ({
  machines: [{ id: "m1", label: "build-box", target: "ubuntu@10.0.0.5", enabled: true, hostId: "ubuntu@10.0.0.5:22" }],
  status: { "ubuntu@10.0.0.5:22": { state: "online", at: 1, rttMs: 42 } },
  ...over,
} as MachinesSnapshot);

// What every view receives as ViewFrame.machine (view protocol 1.1) — pinned so it cannot be dropped quietly.
test("a frame on a saved machine carries its name, link state and round trip, bound to it or by its address", () => {
  assert.deepEqual(frameMachine(snap(), "machine://m1/home/ubuntu/api"), { name: "build-box", state: "online", rttMs: 42 });
  assert.deepEqual(frameMachine(snap(), "ssh://ubuntu@10.0.0.5/home/ubuntu/api"), { name: "build-box", state: "online", rttMs: 42 });
});

test("a local frame carries nothing", () => {
  assert.equal(frameMachine(snap(), "/home/me/api"), undefined);
  assert.equal(frameMachine(snap(), null), undefined);
});

test("a host never saved still says where it is; a machine no longer saved says so, and is not reached", () => {
  assert.deepEqual(frameMachine(snap({ machines: [], status: {} }), "ssh://ubuntu@10.0.0.5/srv"), { name: "ubuntu@10.0.0.5", state: "idle" });
  assert.deepEqual(frameMachine(snap(), "machine://m9/srv"), { name: GONE_MACHINE, state: "offline" });
});

test("no round trip until one is measured", () => {
  const s = snap({ status: { "ubuntu@10.0.0.5:22": { state: "connecting", at: 1 } } });
  assert.deepEqual(frameMachine(s, "machine://m1/srv"), { name: "build-box", state: "connecting" });
});
