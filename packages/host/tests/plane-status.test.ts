// What the control plane hears of an agent is its status: a daemon's reading of its screen
// (`agent.screen`) until its hooks speak, a wait and what screen it says it is; and the session its
// hooks say it is in (`agent.event`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const plane = () => new ControlPlane({
  dir: () => "/nowhere",
  publish: () => {},
  write: () => true,
  spawned: () => {},
  methods: () => { throw new Error("no methods here"); },
  windowsUp: () => false,
} as unknown as ControlPlaneOptions);

test("a screen reading is the agent's status, with what screen it says; one that says it as anything but text says nothing", () => {
  const p = plane();
  p.event("agent.screen", { tileId: "hm:t1", state: "permission", says: "trust" });
  const at = () => { const s = p.status.get("t1")!; return { state: s.state, kind: s.kind, says: s.says }; };
  assert.deepEqual(at(), { state: "waiting", kind: "permission", says: "trust" });
  p.event("agent.screen", { tileId: "hm:t1", state: "permission", says: 7 });
  assert.deepEqual(at(), { state: "waiting", kind: "permission", says: undefined });
  p.event("agent.screen", { tileId: "hm:t1", state: "nonsense", says: "trust" });
  assert.deepEqual(at(), { state: "waiting", kind: "permission", says: undefined }, "a state not read from a screen is no reading");
});

test("the session an agent's hooks say it is in is its status's; one that says none keeps it", () => {
  const p = plane();
  p.event("agent.event", { tileId: "hm:t1", event: "session.started", sessionId: "5f0c3a1e" });
  assert.equal(p.status.get("t1")?.session, "5f0c3a1e");
  p.event("agent.event", { tileId: "hm:t1", event: "turn.started" });
  assert.equal(p.status.get("t1")?.session, "5f0c3a1e");
});
