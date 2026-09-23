// The generic observe hook, run for real: node executes the generated script with an agent's
// payload on stdin, and a unix socket stands in for the control plane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { agentEventHookSource } from "../../src/main/hcp/agent-event-hook-source.ts";

async function run(env: Record<string, string>, payload: unknown): Promise<unknown[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evh-"));
  const script = path.join(dir, "hook.cjs");
  const sock = path.join(dir, "s.sock");
  fs.writeFileSync(script, agentEventHookSource());
  const got: unknown[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d; });
    c.on("end", () => { for (const l of buf.split("\n")) if (l.trim()) got.push(JSON.parse(l)); });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const child = spawn(process.execPath, [script, sock], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 50));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, "a hook always exits 0 so the agent never waits on us");
  return got;
}

test("reports the canonical event from its environment, with only whitelisted ids from the payload", async () => {
  const got = await run(
    { HIVEMIND_TILE: "hm:t1", HIVE_EVENT: "turn.ended", HIVE_EVENT_OUTCOME: "failed" },
    { hook_event_name: "StopFailure", session_id: "s-1", transcript_path: "/h/.claude/p/x.jsonl", last_assistant_message: "secret reply", prompt: "user text" },
  );
  assert.deepEqual(got, [{ t: "event", topic: "agent.event", data: { tileId: "hm:t1", event: "turn.ended", outcome: "failed", transcriptPath: "/h/.claude/p/x.jsonl", sessionId: "s-1" } }]);
  assert.ok(!JSON.stringify(got).includes("secret"), "agent-written text never leaves the hook");
});

test("an input request carries its kind; a subagent event its id", async () => {
  const [a] = await run({ HIVEMIND_TILE: "hm:t1", HIVE_EVENT: "input.requested", HIVE_EVENT_KIND: "permission" }, { tool_name: "Bash", tool_input: { command: "rm -rf" } });
  assert.deepEqual((a as { data: unknown }).data, { tileId: "hm:t1", event: "input.requested", kind: "permission" });
  const [b] = await run({ HIVEMIND_TILE: "hm:t1", HIVE_EVENT: "subagent.started" }, { agent_id: 42 });
  assert.deepEqual((b as { data: unknown }).data, { tileId: "hm:t1", event: "subagent.started", agentId: "42" });
});

test("fails open: no event, no tile, or unreadable stdin sends nothing and still exits 0", async () => {
  assert.deepEqual(await run({ HIVEMIND_TILE: "hm:t1" }, {}), []);
  assert.deepEqual(await run({ HIVE_EVENT: "turn.ended" }, {}), []);
  assert.equal((await run({ HIVEMIND_TILE: "hm:t1", HIVE_EVENT: "turn.started" }, "not json")).length, 1);
});
