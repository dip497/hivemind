import { test } from "node:test";
import assert from "node:assert/strict";
import { machineForRequest } from "../../src/renderer/src/machines/store";
import type { MachineInfo } from "../../src/shared/ipc";

const m = (id: string): MachineInfo =>
  ({ id, label: id, target: `user@${id}`, enabled: true }) as MachineInfo;
const machines = [m("a"), m("b")];

// Clicking a machine has to open THAT machine — in the rail and in the list alike.
test("a request naming a machine opens it", () => {
  assert.equal(machineForRequest({ kind: "manage", machineId: "b" }, machines)?.id, "b");
  assert.equal(machineForRequest({ kind: "pick", frameId: "f1", machineId: "a" }, machines)?.id, "a");
});

test("naming none opens the list", () => {
  assert.equal(machineForRequest({ kind: "manage" }, machines), undefined);
  assert.equal(machineForRequest({ kind: "pick", frameId: "f1" }, machines), undefined);
  assert.equal(machineForRequest({ kind: "add" }, machines), undefined);
  assert.equal(machineForRequest(null, machines), undefined);
});

// Removed between the click and the dialog opening: the list, not an empty screen.
test("a machine that is gone falls back to the list", () => {
  assert.equal(machineForRequest({ kind: "manage", machineId: "gone" }, machines), undefined);
});
