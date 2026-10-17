// Putting agents to sleep from the window (workspace/sleep-agents.ts), against window.hive as the
// host answers it: nothing is forced at first; the agents kept awake because they work or wait on
// someone are asked about once, together, and only those are then forced, each by its id; kept
// awake by the person, they are not reported as failures; an agent kept awake for another reason
// is never asked about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_STATUS } from "@hivemind/agents";
import type { SleepAnswer } from "@hivemind/workspace-api/agents";
import { setHostedStatus } from "../../src/renderer/src/agent-status-bus.ts";
import { putToSleep } from "../../src/renderer/src/workspace/sleep-agents.ts";

const status = (state: "idle" | "working" | "waiting", kind?: "permission") => ({ ...INITIAL_STATUS, state, ...(kind ? { kind } : {}), source: "hooks" as const, since: 1 });

/** A workspace's agents as the host sees them, and every sleep the window asked of it. */
function host(tiles: Record<string, { state: "idle" | "working" | "waiting"; kind?: "permission"; cannot?: string }>) {
  const asked: Array<{ target?: string; force: boolean }> = [];
  for (const [id, t] of Object.entries(tiles)) setHostedStatus(id, status(t.state, t.kind));
  const agentSleep = async (_repo: string, target: string | undefined, force = false): Promise<SleepAnswer> => {
    asked.push({ ...(target ? { target } : {}), force });
    const answer: SleepAnswer = { slept: [], skipped: [] };
    for (const [id, t] of Object.entries(tiles)) {
      if (target && target !== "frame" && target !== id) continue;
      if (t.cannot) answer.skipped.push({ tile: id, why: t.cannot });
      else if (!force && t.state !== "idle") answer.skipped.push({ tile: id, why: `${t.state}: --force puts it to sleep anyway` });
      else answer.slept.push(id);
    }
    return answer;
  };
  (globalThis as { window?: unknown }).window = { hive: { agentSleep } };
  return { asked };
}

test("the busy agents of a frame are asked about once, together; yes forces only them, each by its id", async () => {
  const h = host({ a: { state: "idle" }, b: { state: "working" }, c: { state: "waiting", kind: "permission" }, d: { state: "idle", cannot: "not an agent" } });
  const asks: string[][] = [];
  const answer = await putToSleep("/w", "frame", async (busy) => { asks.push(busy); return true; });
  assert.deepEqual(asks, [["b", "c"]]);
  assert.deepEqual(h.asked, [{ target: "frame", force: false }, { target: "b", force: true }, { target: "c", force: true }]);
  assert.deepEqual(answer, { slept: ["a", "b", "c"], skipped: [{ tile: "d", why: "not an agent" }] });
});

test("kept awake by the person, busy agents are neither forced nor reported; the rest still are", async () => {
  const h = host({ e: { state: "working" }, f: { state: "idle", cannot: "asleep already" }, g: { state: "idle" } });
  const answer = await putToSleep("/w", undefined, async () => false);
  assert.deepEqual(h.asked, [{ force: false }]);
  assert.deepEqual(answer, { slept: ["g"], skipped: [{ tile: "f", why: "asleep already" }] });
});

test("with no agent busy nobody is asked", async () => {
  host({ i: { state: "idle" }, j: { state: "idle", cannot: "Acme cannot resume its conversation: it would wake blank" } });
  let asked = false;
  const answer = await putToSleep("/w", "frame", async () => { asked = true; return true; });
  assert.equal(asked, false);
  assert.deepEqual(answer.slept, ["i"]);
});
