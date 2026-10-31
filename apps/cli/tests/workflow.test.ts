// A workflow run from the workspace API alone (workflow.ts): which workers start with what task,
// how many at once, a spawn turned away for coming too fast tried again, a pipeline stopping at
// the first stage without a reply, and the replies gathered in their items' order.
import { expect, test } from "bun:test";
import type { AgentRead } from "@hivemind/workspace-api/agents";
import { HcpCliError } from "../src/hcp.js";
import { readTurn, runWorkflow } from "../src/workflow.js";
import type { WorkflowPlan } from "../src/ctl-args.js";

const plan = (over: Partial<WorkflowPlan>): WorkflowPlan => ({
  shape: "fanout", items: [], prompt: "", stages: [], input: null, reducePrompt: "", program: "claude", turnMs: 10_000, concurrency: 6, close: false, ...over,
});

/** A host whose workers reply `reply(prompt)` (null: the turn does not end), slowest first. */
function host(reply: (prompt: string) => AgentRead["finalStatus"] | string, refusals = 0) {
  const asked: string[] = [];
  const prompts = new Map<string, string>();
  let live = 0;
  let most = 0;
  let n = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "agent.start") {
      const { prompt, name } = params[1] as { prompt: string; name: string };
      if (refusals-- > 0) throw new HcpCliError("RATE_LIMITED", "too fast", 7);
      if (prompt === "unstartable") throw new HcpCliError("DEPTH_EXCEEDED", "too deep", 7);
      const tile = `w${++n}`;
      prompts.set(tile, prompt);
      asked.push(`start ${name}: ${prompt}`);
      most = Math.max(most, ++live);
      return { tile };
    }
    if (method === "agent.read") {
      const prompt = prompts.get(params[0] as string)!;
      await new Promise((r) => setTimeout(r, prompt.length));
      live--;
      const r = reply(prompt);
      return r === "timeout" || r === "closed" ? { text: null, finalStatus: r, truncated: false } : { text: r, finalStatus: "turn", truncated: false };
    }
    asked.push(`${method} ${String(params[0])}`);
    return { closed: true };
  };
  return { d: { call }, asked, most: () => most };
}

test("fanout: every item's worker, at most so many at once, replies in item order; closed only once it replied", async () => {
  const h = host((p) => (p === "do bb" ? "timeout" : `did ${p}`));
  const r = await runWorkflow(h.d, "/w", plan({ items: ["aaaa", "bb", "c"], prompt: "do {item}", concurrency: 2, close: true, turnMs: 1000 }));
  expect(r).toEqual({ shape: "fanout", items: [
    { item: "aaaa", tile: "w1", status: "turn", text: "did do aaaa" },
    { item: "bb", tile: "w2", status: "timeout", text: null },
    { item: "c", tile: "w3", status: "turn", text: "did do c" },
  ] });
  expect(h.most()).toBe(2);
  expect(h.asked.filter((a) => a.startsWith("agent.close")).sort()).toEqual(["agent.close w1", "agent.close w3"]);
});

test("a worker whose turn ended waiting on work it started has not answered: it is read again, and closed only once it has", async () => {
  const reads: AgentRead[] = [
    { text: "started a workflow", finalStatus: "turn", truncated: false, awaiting: 1 },
    { text: "the workflow found 3 bugs", finalStatus: "turn", truncated: false },
  ];
  const asked: string[] = [];
  const call = async (method: string): Promise<unknown> => {
    asked.push(method);
    return method === "agent.start" ? { tile: "w1" } : method === "agent.read" ? reads.shift() : { closed: true };
  };
  const r = await runWorkflow({ call } as never, "/w", plan({ items: ["a"], prompt: "{item}", close: true, turnMs: 1000 }));
  expect(r).toEqual({ shape: "fanout", items: [{ item: "a", tile: "w1", status: "turn", text: "the workflow found 3 bugs" }] });
  expect(asked).toEqual(["agent.start", "agent.read", "agent.read", "agent.close"]);
});

test("a worker still waiting on that work when the time runs out says what it said, and is left running", async () => {
  const asked: string[] = [];
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    asked.push(method);
    if (method === "agent.start") return { tile: "w1" };
    if (method !== "agent.read") return { closed: true };
    return params[1] === 0 || asked.filter((m) => m === "agent.read").length > 1
      ? { text: null, finalStatus: "working", truncated: false }
      : { text: "started a workflow", finalStatus: "turn", truncated: false, awaiting: 1 };
  };
  const r = await runWorkflow({ call } as never, "/w", plan({ items: ["a"], prompt: "{item}", close: true, turnMs: 1 }));
  expect(r).toEqual({ shape: "fanout", items: [{ item: "a", tile: "w1", status: "working", text: "started a workflow" }] });
  expect(asked).not.toContain("agent.close");
});

test("a spawn turned away for coming too fast is tried again; one refused otherwise is that item's error, and the rest run", async () => {
  const waits: number[] = [];
  const h = host((p) => `did ${p}`, 2);
  const r = await runWorkflow(h.d, "/w", plan({ items: ["a", "b"], prompt: "{item}", concurrency: 1 }), async (ms) => { waits.push(ms); });
  expect(waits).toEqual([1500, 1500]);
  expect(r).toMatchObject({ items: [{ item: "a", status: "turn" }, { item: "b", status: "turn" }] });
  const pressed: number[] = [];
  const always = await runWorkflow(host((p) => p, 100).d, "/w", plan({ items: ["a"], prompt: "{item}" }), async (ms) => { pressed.push(ms); });
  expect([pressed.length, always]).toEqual([6, { shape: "fanout", items: [{ item: "a", tile: null, status: "error", text: "too fast" }] }]);
  const refused = await runWorkflow(host((p) => p).d, "/w", plan({ items: ["x", "y"], prompt: "unstartable" }));
  expect(refused).toMatchObject({ items: [{ item: "x", tile: null, status: "error", text: "too deep" }, { item: "y", status: "error" }] });
});

test("pipeline: each stage is given the last one's reply, and the chain stops at a stage that gives none", async () => {
  const h = host((p) => (p.includes("fail") ? "closed" : `<${p}>`));
  expect(await runWorkflow(h.d, "/w", plan({ shape: "pipeline", stages: ["one {input}", "two {input}"], input: "seed" }))).toEqual({
    shape: "pipeline", steps: [{ item: "stage 1", tile: "w1", status: "turn", text: "<one seed>" }, { item: "stage 2", tile: "w2", status: "turn", text: "<two <one seed>>" }], output: "<two <one seed>>",
  });
  const stopped = await runWorkflow(host((p) => (p.includes("fail") ? "closed" : p)).d, "/w", plan({ shape: "pipeline", stages: ["fail", "never"] }));
  expect(stopped).toEqual({ shape: "pipeline", steps: [{ item: "stage 1", tile: "w1", status: "closed", text: null }], output: null });
});

test("mapreduce: the reducer is given every reply under its item", async () => {
  const h = host((p) => (p.startsWith("sum") ? "total" : p.toUpperCase()));
  const r = await runWorkflow(h.d, "/w", plan({ shape: "mapreduce", items: ["a", "b"], prompt: "{item}", reducePrompt: "sum {results}" }));
  expect(r).toMatchObject({ shape: "mapreduce", reduced: "total", reducerStatus: "turn" });
  expect(h.asked.at(-1)).toBe("start (reduce): sum ## a\nA\n\n## b\nB");
});

test("a read waits in short slices for the turn, and stops once the agent is gone", async () => {
  const asked: number[] = [];
  const answers: AgentRead["finalStatus"][] = ["timeout", "closed", "turn"];
  const d = { call: async (_m: string, params: unknown[]) => { asked.push(params[1] as number); return { text: null, finalStatus: answers.shift()!, truncated: false }; } };
  expect((await readTurn(d, "w1", 45_000)).finalStatus).toBe("closed");
  expect(asked).toEqual([10_000, 10_000]);
});
