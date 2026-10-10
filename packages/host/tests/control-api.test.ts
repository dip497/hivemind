// What the workspace API asks the control plane by name (control-api.ts): each method is carried
// out by the control plane as the caller, its answer in the API's shape; an agent on the drive
// socket asks from its own tile, as `hive ctl` does; and a malformed call asks nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connection } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { controlApi } from "../src/control-api.ts";

const person: Connection = { actor: { kind: "person" }, send: () => {}, closed: new AbortController().signal };
const agent: Connection = { actor: { kind: "peer", person: "t7", device: "t7", access: "agents", client: "reviewer", tile: "t7" }, send: () => {}, closed: new AbortController().signal };

/** The control plane, answering `answers[verb]`: what it was asked, and as whom. */
function plane(answers: Record<string, unknown> = {}) {
  const asked: Array<{ verb: string; params: unknown; actor: Connection["actor"] }> = [];
  const domain = controlApi({
    control: () => ({ dispatch: async (verb, params, call) => { asked.push({ verb, params, actor: call.actor }); return answers[verb]; } }),
  });
  const call = (from: Connection, method: string, ...params: unknown[]) => (domain.answers as Record<string, (f: Connection, ...p: unknown[]) => unknown>)[method]!(from, ...params);
  return { asked, call };
}
const code = async (f: () => unknown): Promise<string> => { try { await f(); return "ok"; } catch (e) { return e instanceof ApiError ? e.code : "thrown"; } };

test("each method is the control plane's verb, asked as the caller, its answer in the API's shape", async () => {
  const c = plane({ "tile.rename": { name: "reviewer" }, "agent.send_keys": { keys: 2 }, "tool.open": { tileId: "hm:t9" }, "agent.read": { text: "done", finalStatus: "turn", truncated: false }, "tools.rescan": { ok: true } });
  assert.deepEqual(await c.call(person, "agent.rename", "t1", "reviewer"), { name: "reviewer" });
  assert.deepEqual(await c.call(person, "agent.keys", "t1", ["y", "Enter"]), { keys: 2 });
  assert.deepEqual(await c.call(person, "agent.read", "t1", 5_000), { text: "done", finalStatus: "turn", truncated: false });
  await c.call(person, "agent.output", "t1", 12);
  await c.call(person, "agent.sessions", "/work/api", "claude", 3);
  assert.deepEqual(await c.call(person, "tool.open", "/work/api", { tool: "a/b/c", url: "https://x" }), { tile: "hm:t9" });
  await c.call(person, "link.connect", "t1", "t2");
  await c.call(person, "link.disconnect", "t1");
  assert.equal(await c.call(person, "tools.rescan"), null, "a machine method asked for what it does answers null");
  assert.deepEqual(c.asked.map(({ verb, params }) => [verb, params]), [
    ["tile.rename", { tileId: "t1", name: "reviewer" }],
    ["agent.send_keys", { tileId: "t1", keys: ["y", "Enter"] }],
    ["agent.read", { tileId: "t1", timeoutMs: 5_000 }],
    ["agent.output", { tileId: "t1", lines: 12 }],
    ["agent.sessions", { agent: "claude", cwd: "/work/api", limit: 3 }],
    ["tool.open", { repo: "/work/api", tool: "a/b/c", frame: undefined, url: "https://x" }],
    ["tile.connect", { srcTileId: "t1", dstTileId: "t2" }],
    ["tile.disconnect", { srcTileId: "t1" }],
    ["tools.rescan", {}],
  ]);
  assert.ok(c.asked.every((a) => a.actor === person.actor), "asked as the caller");
});

test("an agent on the drive socket asks from its own tile; the person asks from none", async () => {
  const c = plane({ "tile.rename": { name: "x" } });
  await c.call(agent, "link.connect", "t7", "t8");
  await c.call(person, "link.connect", "t7", "t8");
  assert.deepEqual(c.asked.map((a) => a.params), [
    { srcTileId: "t7", dstTileId: "t8", callerTile: "hm:t7" },
    { srcTileId: "t7", dstTileId: "t8" },
  ]);
});

test("a malformed call is a bad request, and the control plane is asked nothing", async () => {
  const c = plane();
  for (const [method, ...params] of [
    ["agent.rename", "", "x"], ["agent.keys", "t1", []], ["agent.keys", "t1", ["y", 3]], ["agent.read", "t1", -1], ["agent.output", "t1", 1.5],
    ["agent.sessions", "/work/api", "", 3], ["agent.sessions", "/work/api", "claude", 0], ["tool.open", null, { tool: "a/b/c" }],
    ["link.connect", "t1", null], ["link.disconnect", "t1", 4], ["host.join", ""],
  ] as const) {
    assert.equal(await code(() => c.call(person, method, ...params)), "BAD_REQUEST", `${method} ${JSON.stringify(params)}`);
  }
  assert.deepEqual(c.asked, []);
});
