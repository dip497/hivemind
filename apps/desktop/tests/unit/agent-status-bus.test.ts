// The renderer's status bus: an agent tile's status is the host's (read as a kind by
// @hivemind/agent-host/tile-status, tested there); a tile's own reports cover plain shells and
// how a process exited.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearStatus, publishStatus, setHostedStatus, setLabel, statusOf, subscribeStatus, type StatusEvent,
} from "../../src/renderer/src/agent-status-bus.ts";
import type { SessionStatus } from "@hivemind/agent-host/status-store";

const hosted = (over: Partial<SessionStatus>): SessionStatus =>
  ({ state: "idle", subagents: [], background: 0, compacting: false, source: "hooks", since: 0, ...over });

test("an agent tile follows the host; a relabel re-emits under the new name", () => {
  const seen: StatusEvent[] = [];
  const off = subscribeStatus((e) => { if (e.tileId === "a1") seen.push(e); });
  setLabel("a1", "claude #1");
  setHostedStatus("a1", hosted({ state: "working" }));
  setHostedStatus("a1", hosted({ state: "working", compacting: true })); // same kind: no emit
  setHostedStatus("a1", hosted({ state: "waiting", kind: "permission" }));
  setLabel("a1", "Fix the flaky test");
  assert.deepEqual(seen.map((e) => `${e.label}:${e.status}`), ["claude #1:working", "claude #1:permission", "Fix the flaky test:permission"]);
  off();
  clearStatus("a1");
});

test("the exit the tile saw carries its code over the host's bare exit", () => {
  setHostedStatus("a2", hosted({ state: "exited" }));
  publishStatus({ tileId: "a2", label: "a2", status: "exited", exitCode: 3, detail: "killed by signal 9" });
  const seen: StatusEvent[] = [];
  const off = subscribeStatus((e) => { if (e.tileId === "a2") seen.push(e); });
  assert.deepEqual(seen.at(-1), { tileId: "a2", label: "a2", status: "exited", exitCode: 3, detail: "killed by signal 9" });
  off();
  clearStatus("a2");
});

test("a plain shell is what it says about itself; unmount keeps the host's status for a remount", () => {
  publishStatus({ tileId: "s1", label: "bash", status: "working" });
  assert.equal(statusOf("s1"), "working");
  clearStatus("s1");
  assert.equal(statusOf("s1"), null);
  setHostedStatus("a3", hosted({ state: "working" }));
  clearStatus("a3");
  assert.equal(statusOf("a3"), "working");
});
