// A plan handed off for review (`review.open`, `hive ctl open-review`): the agent that wrote it
// waits on it, shown waiting, until it is answered; a caller that stops waiting ends the wait, so
// a late answer answers nothing; and a plan is reviewed for an agent, never for nobody.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import { useAuthoredAgents } from "./authored-agents.ts";
import { PERSON, fromTile, workspaceDeps } from "./hcp-workspace.ts";

useAuthoredAgents();

function made() {
  const deps = workspaceDeps();
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: () => true,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    ...deps,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  return { deps, dispatch };
}

test("the agent waits on its plan, shown waiting, until it is answered: the answer is what the caller gets", async () => {
  const { deps, dispatch } = made();
  const reviewed = dispatch("review.open", { plan: "1. Split it", cwd: "/work/repo" }, fromTile("tile-a"));
  const wait = deps.waits.of("tile-a")!;
  assert.deepEqual({ kind: wait.kind, plan: wait.plan, cwd: wait.cwd }, { kind: "plan", plan: "1. Split it", cwd: "/work/repo" });
  assert.deepEqual({ state: deps.status.get("tile-a")?.state, kind: deps.status.get("tile-a")?.kind }, { state: "waiting", kind: "plan" });
  deps.waits.answer("tile-a", wait.since, "deny", "smaller steps");
  assert.deepEqual(await reviewed, { decision: "deny", feedback: "smaller steps" });
  assert.notEqual(deps.status.get("tile-a")?.state, "waiting");
});

test("a caller that stops waiting ends the wait: the agent is not shown waiting, and a late answer answers nothing", async () => {
  const { deps, dispatch } = made();
  const hook = new AbortController();
  const reviewed = dispatch("review.open", { plan: "1. Split it" }, { ...fromTile("tile-a"), signal: hook.signal });
  const { since } = deps.waits.of("tile-a")!;
  hook.abort();
  await assert.rejects(reviewed, (e: Error & { code?: string }) => e.code === "TIMEOUT" && /stopped waiting/.test(e.message));
  assert.notEqual(deps.status.get("tile-a")?.state, "waiting");
  assert.deepEqual(deps.waits.answer("tile-a", since, "allow"), { answered: false });
});

test("a plan the agent no longer waits on, because it waits on another, ends the first review", async () => {
  const { deps, dispatch } = made();
  const first = dispatch("review.open", { plan: "1. Split it" }, fromTile("tile-a"));
  const second = dispatch("review.open", { plan: "1. Split it smaller" }, fromTile("tile-a"));
  await assert.rejects(first, (e: Error & { code?: string }) => e.code === "TIMEOUT" && /something else/.test(e.message));
  const wait = deps.waits.of("tile-a")!;
  assert.equal(wait.plan, "1. Split it smaller");
  deps.waits.answer("tile-a", wait.since, "allow");
  assert.deepEqual(await second, { decision: "allow" });
});

test("a plan is reviewed for the agent that wrote it: with no agent's tile it is a bad request, and nothing waits", async () => {
  const { deps, dispatch } = made();
  await assert.rejects(dispatch("review.open", { plan: "1. Split it" }, PERSON), { code: "BAD_REQUEST" });
  assert.deepEqual(deps.waits.all(), []);
});
