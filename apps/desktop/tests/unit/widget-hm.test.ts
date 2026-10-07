// A widget's worker reaches the window's view client by naming a call. What it can name is the
// client's public calls and its commands, nothing else: not the client's internals, nor anything
// a name leads to (a constructor reached that way would run code in the window).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ViewClient } from "@hivemind/view-sdk";
import { bridgeClient } from "../../src/renderer/src/board-objects/widget-hm";

function fakeClient() {
  const calls: string[] = [];
  const client = {
    hello: { pluginId: "w" }, capabilities: ["workspace:spawn"], viewport: { w: 0, h: 0 }, visible: true,
    device: { touch: false, compact: false }, settings: { a: 1 }, features: ["agents"],
    agents: async () => { calls.push("agents"); return [{ id: "claude" }]; },
    subscribeStatus: (tileId: string, cb: (s: string) => void) => { calls.push(`status ${tileId}`); cb("idle"); return () => calls.push(`unsub ${tileId}`); },
    send: () => calls.push("send"),
    commands: { spawnAgent: (a: string | null) => { calls.push(`spawn ${a}`); } },
  };
  return { client: client as unknown as ViewClient, calls };
}

test("a call the worker names is the client's, answered by message, values sent first", async () => {
  const { client, calls } = fakeClient();
  const out: Array<Record<string, unknown>> = [];
  const b = bridgeClient(client, (m) => out.push(m as Record<string, unknown>));
  assert.deepEqual(out[0], { type: "hm-values", values: { hello: { pluginId: "w" }, capabilities: ["workspace:spawn"], viewport: { w: 0, h: 0 }, visible: true, device: { touch: false, compact: false }, settings: { a: 1 }, features: ["agents"] } });
  b.handle({ type: "hm-call", req: 1, path: ["agents"], args: [] } as never);
  b.handle({ type: "hm-call", req: 2, path: ["commands", "spawnAgent"], args: ["codex"] } as never);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["agents", "spawn codex"]);
  const replies = out.slice(1).sort((x, y) => Number(x.req) - Number(y.req));
  assert.deepEqual(replies, [{ type: "hm-reply", req: 1, ok: true, value: [{ id: "claude" }] }, { type: "hm-reply", req: 2, ok: true, value: null }]);
});

test("a callback is called back by id, and its unsubscribe ends it", () => {
  const { client, calls } = fakeClient();
  const out: Array<Record<string, unknown>> = [];
  const b = bridgeClient(client, (m) => out.push(m as Record<string, unknown>));
  b.handle({ type: "hm-call", req: 7, path: ["subscribeStatus"], args: ["t1", { __fn: 8 }] } as never);
  assert.deepEqual(out.at(-1), { type: "hm-cb", fn: 8, args: ["idle"] });
  b.handle({ type: "hm-unsub", req: 7 } as never);
  assert.deepEqual(calls, ["status t1", "unsub t1"]);
});

test("nothing but the client's public calls and its commands can be named", async () => {
  const { client, calls } = fakeClient();
  const out: Array<Record<string, unknown>> = [];
  const b = bridgeClient(client, (m) => out.push(m as Record<string, unknown>));
  const refused = [["send"], ["constructor"], ["agents", "constructor"], ["commands", "constructor"], ["__proto__"], ["commands"], "agents"];
  refused.forEach((path, i) => b.handle({ type: "hm-call", req: 100 + i, path, args: [] } as never));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, []);
  assert.equal(out.filter((m) => m.type === "hm-reply" && m.ok === false).length, refused.length);
});
