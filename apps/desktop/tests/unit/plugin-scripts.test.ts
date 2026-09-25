// The hook scripts agent plugins ship, run for real: node executes each one with the host's SDK,
// the agent's payload on stdin, and a unix socket standing in for the control plane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SDK_ENV, SDK_FILE, sdkSource } from "@hivemind/agent-sdk";
import { authoredAsset } from "./authored-agents.ts";

type Line = Record<string, unknown>;

async function run(agent: string, file: string, payload: unknown, answer: (m: Line) => Line | null, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-"));
  fs.writeFileSync(path.join(dir, SDK_FILE), sdkSource());
  fs.writeFileSync(path.join(dir, file), authoredAsset(agent, file));
  const sock = path.join(dir, "hcp.sock");
  const got: Line[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Line; buf = buf.slice(nl + 1);
        if (m.method === "initialize") { c.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n"); continue; }
        got.push(m);
        const res = answer(m);
        if (res) c.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...res }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const child = spawn(process.execPath, [path.join(dir, file)], {
    env: { PATH: process.env.PATH ?? "", HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", [SDK_ENV.sdk]: path.join(dir, SDK_FILE), [SDK_ENV.sock]: sock, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(payload));
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 30));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { got, stdout, stderr, code };
}

const ok = (m: Line): Line | null => (m.id ? { result: { ok: true } } : null);
const decide = (decision: string, reason?: string) => (m: Line): Line | null =>
  (m.id ? { result: { decision, ...(reason ? { reason } : {}) } } : null);

test("claude turn end: the reply goes on its own request, then the turn end with running shells counted", async () => {
  const { got, code } = await run("claude", "hive-turn-end.cjs", {
    last_assistant_message: "done — see the diff",
    background_tasks: [{ status: "running", command: "npm run dev --token=secret" }, { status: "completed" }],
  }, ok);
  assert.equal(code, 0);
  assert.deepEqual(got.map((m) => m.method), ["agent.reply", "agent.event"]);
  assert.deepEqual((got[0] as { params: unknown }).params, { tileId: "hm:t1", text: "done — see the diff" });
  assert.deepEqual((got[1] as { params: unknown }).params, { background: 1, tileId: "hm:t1", event: "turn.ended" });
  assert.ok(!JSON.stringify(got[1]).includes("secret"));
});

test("claude approval: the supervisor's decision becomes claude's; no answer falls back to claude's own prompt", async () => {
  const payload = { tool_name: "Bash", tool_input: { command: "rm -rf build" } };
  const deny = await run("claude", "hive-approve.cjs", payload, decide("deny", "not now"), { HIVE_SUPERVISE: "all" });
  assert.deepEqual(JSON.parse(deny.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not now" } });
  assert.deepEqual((deny.got[0] as { params: unknown }).params, { callerTile: "hm:t1", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  const allow = await run("claude", "hive-approve.cjs", payload, decide("allow"), { HIVE_SUPERVISE: "Bash,Write" });
  assert.equal(JSON.parse(allow.stdout).hookSpecificOutput.permissionDecision, "allow");
  const ask = await run("claude", "hive-approve.cjs", payload, decide("ask"), { HIVE_SUPERVISE: "all" });
  assert.equal(ask.stdout, "");
  const notBrokered = await run("claude", "hive-approve.cjs", payload, decide("allow"), { HIVE_SUPERVISE: "Write" });
  assert.equal(notBrokered.stdout, "");
  assert.deepEqual(notBrokered.got, []);
});

test("kiro approval fails closed once a tool is brokered, and passes tools that are not", async () => {
  const payload = { tool_name: "execute_bash", tool_input: { command: "ls" } };
  const ask = await run("kiro", "hcp-kiro-approval-hook.cjs", payload, decide("ask"), { HIVE_SUPERVISE: "all" });
  assert.equal(ask.code, 2);
  assert.match(ask.stderr, /did not answer/);
  assert.equal((await run("kiro", "hcp-kiro-approval-hook.cjs", payload, decide("allow"), { HIVE_SUPERVISE: "all" })).code, 0);
  assert.equal((await run("kiro", "hcp-kiro-approval-hook.cjs", payload, decide("deny"), { HIVE_SUPERVISE: "fs_write" })).code, 0);
});

test("droid turn end reads the reply from droid's own transcript", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-tx-"));
  const tx = path.join(dir, "s.jsonl");
  fs.writeFileSync(tx, [
    JSON.stringify({ role: "user", content: "hi" }),
    JSON.stringify({ role: "assistant", content: [{ type: "text", text: "first" }] }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FINAL" }] } }),
  ].join("\n"));
  const { got } = await run("droid", "hive-turn-end.cjs", { transcript_path: tx }, ok);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual((got[0] as { params: unknown }).params, { tileId: "hm:t1", text: "FINAL" });
  assert.equal((got[1] as { params: { event: string } }).params.event, "turn.ended");
});

test("droid notifications: permission and elicitation need you; idle does not", async () => {
  const kinds = [];
  for (const t of ["permission_prompt", "elicitation_dialog", "idle_prompt"]) {
    const { got } = await run("droid", "hive-notify.cjs", { notification_type: t, message: "secret text" }, ok);
    kinds.push(got.map((m) => (m.params as { kind: string }).kind));
    assert.ok(!JSON.stringify(got).includes("secret"));
  }
  assert.deepEqual(kinds, [["permission"], ["question"], []]);
});
