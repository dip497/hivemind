// What the control plane hears of an agent is its status: a daemon's reading of its screen
// (`agent.screen`) until its hooks speak, a wait and what screen it says it is; and the session its
// hooks say it is in (`agent.event`); and what a tile's screen last showed (`tile.line`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const plane = (o: Partial<ControlPlaneOptions> = {}) => new ControlPlane({
  dir: () => "/nowhere",
  publish: () => {},
  write: () => true,
  spawned: () => {},
  methods: () => { throw new Error("no methods here"); },
  windowsUp: () => false,
  ...o,
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

test("what a tile's screen last showed is kept by its bare id, and told; anything but text is no line, and a tile forgotten keeps none", () => {
  let told = 0;
  const p = plane({ lineChanged: () => told++ });
  p.event("tile.line", { tileId: "hm:t1", line: "building" });
  assert.deepEqual([...p.lines], [["t1", "building"]]);
  assert.equal(told, 1);
  p.event("tile.line", { tileId: "hm:t1", line: 7 });
  p.event("tile.line", { line: "nobody's" });
  assert.deepEqual([...p.lines], [["t1", "building"]]);
  assert.equal(told, 1);
  p.forget("hm:t1");
  assert.deepEqual([...p.lines], []);
});

test("a startup screen answered (a folder's trust) does not hold the messages sent after it", () => {
  const wrote: string[] = [];
  const p = plane({ signalsTurns: () => true, write: (_pty: string, data: string) => { wrote.push(data); return true; } });
  p.event("agent.screen", { tileId: "hm:t1", state: "permission", says: "trust" });
  p.event("agent.screen", { tileId: "hm:t1", state: "working" });
  p.mailbox.deliver("hm:t1", "hello");
  assert.ok(wrote.some((d) => d.includes("hello")), "the message is typed, not held for a turn that never ends");
  p.mailbox.forget("hm:t1");
});
