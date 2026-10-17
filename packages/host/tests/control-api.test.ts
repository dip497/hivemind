// What the workspace API asks the control plane by name (control-api.ts): each method is the
// control plane's work, its answer in the API's shape; an agent on the drive socket asks from its
// own tile; each effect is recorded under the API's name, as the caller's, and nothing else is;
// and a malformed call asks nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { Intent } from "@hivemind/workspace-host/intents";
import { PROMPT_MAX } from "@hivemind/view-sdk/protocol";
import { controlApi } from "../src/control-api.ts";
import type { ControlWork } from "../src/control/methods.ts";

const person: Connection = { actor: { kind: "person" }, send: () => {}, closed: new AbortController().signal };
const agent: Connection = { actor: { kind: "peer", person: "t7", device: "t7", access: "agents", client: "reviewer", tile: "t7" }, send: () => {}, closed: new AbortController().signal };

/** The control plane, answering each piece of work with `answers[name]`: what it was asked, and
 *  what the API recorded. */
function plane(answers: Partial<Record<keyof ControlWork, unknown>> = {}) {
  const asked: Array<[string, ...unknown[]]> = [];
  const work = new Proxy({} as ControlWork, {
    // Not a promise: awaited, it is the work itself.
    get: (_t, name: string) => (name === "then" ? undefined : (...args: unknown[]) => { asked.push([name, ...args]); return answers[name as keyof ControlWork]; }),
  });
  const recorded: Array<{ verb: string; target?: string; actor: Connection["actor"] }> = [];
  const server = new WorkspaceServer([controlApi({ control: async () => work })], {
    perform: async (actor, intent: Intent<unknown>, run) => {
      const r = await run();
      recorded.push({ verb: intent.verb, ...(intent.target !== undefined ? { target: typeof intent.target === "function" ? intent.target(r) : intent.target } : {}), actor });
      return r;
    },
  });
  const call = async (from: Connection, method: string, ...params: unknown[]) => server.answer(method, params, from);
  return { asked, recorded, call };
}

test("each method is the control plane's work, its answer in the API's shape", async () => {
  const c = plane({ send: true, rename: "reviewer", keys: 2, openTool: "t9", read: { text: "done", finalStatus: "turn", truncated: false }, rescan: { ok: true }, hostStatus: { workspaces: [] } });
  assert.deepEqual(await c.call(person, "agent.send", "t1", "fix the tests\nthen push"), { result: { sent: true } }, "a message may run over lines");
  assert.deepEqual(await c.call(person, "agent.rename", "t1", "reviewer"), { result: { name: "reviewer" } });
  assert.deepEqual(await c.call(person, "agent.keys", "t1", ["y", "Enter"]), { result: { keys: 2 } });
  assert.deepEqual(await c.call(person, "agent.read", "t1", 5_000), { result: { text: "done", finalStatus: "turn", truncated: false } });
  await c.call(person, "agent.sessions", "/work/api", "claude", 3);
  assert.deepEqual(await c.call(person, "tool.open", "/work/api", { tool: "a/b/c", url: "https://x" }), { result: { tile: "t9" } });
  await c.call(person, "link.connect", "t1", "t2");
  await c.call(person, "link.disconnect", "t1");
  assert.deepEqual(await c.call(person, "tools.rescan"), { result: null }, "a machine method asked for what it does answers null");
  assert.deepEqual(await c.call(person, "host.status"), { result: { workspaces: [] } });
  assert.deepEqual(c.asked, [
    ["send", "t1", "fix the tests\nthen push"],
    ["rename", "t1", "reviewer"],
    ["keys", "t1", ["y", "Enter"]],
    ["read", "t1", 5_000],
    ["sessions", "claude", "/work/api", 3],
    ["openTool", undefined, "/work/api", "a/b/c", { frame: undefined, url: "https://x" }],
    ["connect", "t1", "t2"],
    ["disconnect", "t1", undefined],
    ["rescan", "tools"],
    ["hostStatus"],
  ]);
});

test("an agent on the drive socket asks from its own tile; the person asks from none", async () => {
  const c = plane({ openTool: "t9" });
  await c.call(agent, "tool.open", "/work/api", { tool: "a/b/c" });
  await c.call(person, "tool.open", "/work/api", { tool: "a/b/c" });
  await c.call(agent, "view.emit", "ci.build", { ok: true });
  await c.call(agent, "plugin.open", "tool:a/b");
  assert.deepEqual(c.asked.map(([name, caller]) => [name, caller]), [["openTool", "t7"], ["openTool", undefined], ["viewEmit", "t7"], ["pluginOpen", "t7"]]);
});

test("what changes something is recorded under the API's name, as the caller's, against what it acts on; reads are not", async () => {
  const c = plane({ send: true, rename: "x", keys: 1, openTool: "t9", read: { text: null, finalStatus: "timeout", truncated: false }, output: { text: "" } });
  await c.call(agent, "agent.send", "hm:t1", "go");
  await c.call(person, "agent.rename", "t1", "x");
  await c.call(person, "agent.keys", "t1", ["Enter"]);
  await c.call(person, "tool.open", "/work/api", { tool: "a/b/c" });
  await c.call(person, "link.connect", "t1", "hm:t2");
  await c.call(person, "link.disconnect", "t1");
  await c.call(person, "plugin.call", "acme/board", "refresh", null);
  await c.call(person, "settings.reload");
  await c.call(person, "agent.read", "t1", 0);
  await c.call(person, "agent.output", "t1");
  await c.call(person, "tile.focus", "t1");
  await c.call(person, "view.emit", "ci.build", null);
  assert.deepEqual(c.recorded, [
    { verb: "agent.send", target: "t1", actor: agent.actor },
    { verb: "agent.rename", target: "t1", actor: person.actor },
    { verb: "agent.keys", target: "t1", actor: person.actor },
    { verb: "tool.open", target: "t9", actor: person.actor },
    { verb: "link.connect", target: "t1->t2", actor: person.actor },
    { verb: "link.disconnect", target: "t1->*", actor: person.actor },
    { verb: "plugin.call", target: "acme/board:refresh", actor: person.actor },
    { verb: "settings.reload", actor: person.actor },
  ]);
});

test("a malformed call is a bad request, and the control plane is asked nothing", async () => {
  const c = plane();
  for (const [method, ...params] of [
    ["agent.send", "t1", ""], ["agent.send", "t1", "\u001b[2J"], ["agent.send", "t1", "x".repeat(PROMPT_MAX + 1)], ["agent.send", "t1", 7], ["agent.send", "", "hi"],
    ["agent.rename", "", "x"], ["agent.keys", "t1", []], ["agent.keys", "t1", ["y", 3]], ["agent.read", "t1", -1], ["agent.output", "t1", 1.5],
    ["agent.sessions", "/work/api", "", 3], ["agent.sessions", "/work/api", "claude", 0], ["tool.open", null, { tool: "a/b/c" }], ["tool.open", "/work/api", {}],
    ["link.connect", "t1", null], ["link.disconnect", "t1", 4], ["tile.focus", ""], ["host.join", ""],
  ] as const) {
    assert.equal((await c.call(person, method, ...params)).error?.code, "BAD_REQUEST", `${method} ${JSON.stringify(params).slice(0, 60)}`);
  }
  assert.deepEqual(c.asked, []);
});
