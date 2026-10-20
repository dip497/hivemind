// What an agent reads of the plugins running in a window, and what its calls meet: the lifecycle
// (starting, ready, failed), waiting for one still starting, and the code each refusal carries.
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { PluginError, PluginInstances, START_MS, type Starting } from "../src/instances";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** A plugin whose commands answer `answer`, or never (`answer` undefined). */
function plugin(over: Partial<Starting> = {}, answer: (name: string, args: unknown) => unknown = (name, args) => ({ name, args })): Starting {
  return {
    plugin: "@dip497/progress", kind: "widget", instance: "widget-1", label: "Progress",
    commands: [{ name: "add", description: "Add a step" }, { name: "hang", description: "Never answers" }],
    call: async (name, args) => (name === "hang" ? new Promise(() => {}) : answer(name, args)),
    ...over,
  };
}
const states = (p: PluginInstances) => p.list().map((i) => [i.instance, i.state, i.reason ?? null]);
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: PluginError) => [e.code, e.message]);

test("a plugin is starting until its code connects, then ready; one disabled is failed, says why, and stays failed", () => {
  const p = new PluginInstances();
  const w = p.start(plugin());
  expect(states(p)).toEqual([["widget-1", "starting", null]]);
  w.connected();
  expect(states(p)).toEqual([["widget-1", "ready", null]]);
  w.disabled("runaway: 900 ms of long tasks in 5 s");
  w.connected();
  expect(states(p)).toEqual([["widget-1", "failed", "runaway: 900 ms of long tasks in 5 s"]]);
  w.stop();
  expect(p.list()).toEqual([]);
});

test("a plugin has not drawn until its host says it painted; drawing again changes nothing", () => {
  const p = new PluginInstances();
  const w = p.start(plugin());
  w.connected();
  expect(p.list()[0]!.drew).toBe(false);
  w.drew();
  w.drew();
  expect(p.list()[0]!.drew).toBe(true);
});

test("a plugin whose code does not connect in time is failed, saying so; one that connects in time is not", () => {
  const p = new PluginInstances();
  p.start(plugin());
  p.start(plugin({ instance: "widget-2" })).connected();
  jest.advanceTimersByTime(START_MS);
  expect(states(p)).toEqual([["widget-1", "failed", `it did not start in ${START_MS / 1000} s`], ["widget-2", "ready", null]]);
});

test("a call to a plugin still starting waits for it and runs once it is ready; open settles at the same moment", async () => {
  const p = new PluginInstances();
  const w = p.start(plugin());
  const called = p.call("@dip497/progress", "add", { text: "Tag it" }, undefined, Date.now() + 30_000);
  const opened = p.settle({ instance: "widget-1" }, Date.now() + 10_000);
  jest.advanceTimersByTime(800);
  w.connected();
  expect(await called).toEqual({ name: "add", args: { text: "Tag it" } });
  expect((await opened)?.state).toBe("ready");
});

test("what opening answers when its deadline comes first: the plugin as it is then, or nothing when none runs", async () => {
  const p = new PluginInstances();
  p.start(plugin());
  const starting = p.settle({ instance: "widget-1" }, Date.now() + 10_000);
  const none = p.settle({ instance: "widget-9" }, Date.now() + 10_000);
  jest.advanceTimersByTime(10_000);
  expect((await starting)?.state).toBe("starting");
  expect(await none).toBeNull();
});

test("each refusal carries the code an agent's exit status is made from", async () => {
  const p = new PluginInstances();
  const failed = p.start(plugin({ plugin: "agent-board", kind: "view", instance: "agent-board" }));
  failed.disabled("12 malformed or unauthorised messages");
  p.start(plugin({ plugin: "@dip497/worktrees", kind: "tool", instance: "tile-a", label: "Worktrees" })).connected();
  p.start(plugin({ plugin: "@dip497/worktrees", kind: "tool", instance: "tile-b", label: "Worktrees 2" })).connected();
  p.start(plugin({ instance: "widget-1" }));
  const by = Date.now() + 30_000;
  const slow = refusal(p.call("@dip497/progress", "add", null, undefined, Date.now() + 2_000));
  jest.advanceTimersByTime(2_000);
  expect([
    await refusal(p.call("@nobody/nothing", "list", null, undefined, by)),
    await refusal(p.call("@dip497/worktrees", "launch", null, "tile-a", by)),
    await refusal(p.call("@dip497/worktrees", "add", null, "tile-z", by)),
    await refusal(p.call("@dip497/worktrees", "add", null, undefined, by)),
    await refusal(p.call("@dip497/worktrees", "add", "x".repeat(70_000), "tile-a", by)),
    await refusal(p.call("agent-board", "add", null, undefined, by)),
    await slow,
  ].map((r) => r?.[0])).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "BAD_REQUEST", "BAD_REQUEST", "FAILED", "TIMEOUT"]);
  expect((await refusal(p.call("agent-board", "add", null, undefined, by)))?.[1]).toBe("agent-board stopped: 12 malformed or unauthorised messages");
  expect((await slow)?.[1]).toBe("@dip497/progress is still starting");
});

test("a command not answered by the deadline is a TIMEOUT from here; the plugin's own refusal comes back as it said it", async () => {
  const p = new PluginInstances();
  p.start(plugin({}, () => { throw new Error("there is no step 7"); })).connected();
  const hung = refusal(p.call("@dip497/progress", "hang", null, undefined, Date.now() + 5_000));
  jest.advanceTimersByTime(5_000);
  expect(await hung).toEqual(["TIMEOUT", '@dip497/progress did not answer "hang" in 5 s']);
  expect(await refusal(p.call("@dip497/progress", "add", { index: 7 }, undefined, Date.now() + 5_000))).toEqual(["FAILED", "there is no step 7"]);
});

test("a remount stands in for the mount it replaces, and the old mount going does not take the new one with it", async () => {
  const p = new PluginInstances();
  const first = p.start(plugin({ plugin: "agent-board", kind: "view", instance: "agent-board" }));
  first.connected();
  const again = p.start(plugin({ plugin: "agent-board", kind: "view", instance: "agent-board" }));
  expect(states(p)).toEqual([["agent-board", "starting", null]]);
  first.stop();
  expect(states(p)).toEqual([["agent-board", "starting", null]]);
  again.connected();
  expect(await p.call("agent-board", "add", 1, undefined, Date.now() + 1_000)).toEqual({ name: "add", args: 1 });
});

test("closing waits for the plugin to stop, and says when it did not", async () => {
  const p = new PluginInstances();
  const w = p.start(plugin());
  const closed = p.gone({ instance: "widget-1" }, Date.now() + 2_000);
  jest.advanceTimersByTime(500);
  w.stop();
  expect(await closed).toBe(true);
  p.start(plugin({ instance: "widget-2" }));
  const stuck = p.gone({ instance: "widget-2" }, Date.now() + 2_000);
  jest.advanceTimersByTime(2_000);
  expect(await stuck).toBe(false);
});
