// The generic observe hook, run for real against the shared conformance cases: node executes the
// generated script with an agent's payload on stdin, and a unix socket stands in for the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentEventHookSource } from "@hivemind/agent-host/hooks/agent-event-hook-source";

interface Case { name: string; env: Record<string, string>; payload: unknown; expect: unknown; forbidden?: string[] }
const casesFile = fileURLToPath(new URL("../../../../conformance/hook-reports.json", import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(casesFile, "utf8")) as { cases: Case[] };

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
  child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 50));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, "a hook always exits 0 so the agent never waits on us");
  return got;
}

for (const c of cases) {
  test(c.name, async () => {
    const got = await run(c.env, c.payload);
    assert.deepEqual(got, c.expect === null ? [] : [{ jsonrpc: "2.0", method: "agent.event", params: c.expect }]);
    for (const f of c.forbidden ?? []) assert.ok(!JSON.stringify(got).includes(f), `"${f}" must not leave the hook`);
  });
}

/** The hook run as an entry that answers (`HIVE_EVENT_ANSWER=1`), against a host that answers its
 *  `agent.await_answer` with `reply` (a result or an error; null: it closes the connection): every
 *  line the host got, and what the hook printed. */
async function answering(reply: { result: unknown } | { error: unknown } | null): Promise<{ got: Array<Record<string, unknown>>; printed: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evh-"));
  const script = path.join(dir, "hook.cjs");
  const sock = path.join(dir, "s.sock");
  fs.writeFileSync(script, agentEventHookSource());
  const got: Array<Record<string, unknown>> = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        got.push(m);
        if (m.method === "initialize") c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 2 } })}\n`);
        if (m.method !== "agent.await_answer") continue;
        if (reply === null) c.destroy();
        else c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, ...reply })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const env = { PATH: process.env.PATH ?? "", HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", HIVE_EVENT: "input.requested", HIVE_EVENT_KIND: "permission", HIVE_EVENT_ANSWER: "1" };
  const child = spawn(process.execPath, [script, sock], { env, stdio: ["pipe", "pipe", "ignore"] });
  let printed = "";
  child.stdout.on("data", (d) => { printed += d; });
  child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } }));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, "a hook always exits 0");
  return { got, printed };
}

test("a hook that answers reports its event, then asks for the answer on the same connection, as its tile, and prints what the host answers", async () => {
  const printed = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
  const r = await answering({ result: { stdout: printed } });
  assert.equal(r.printed, printed);
  assert.deepEqual(r.got.map((m) => m.method), ["agent.event", "initialize", "agent.await_answer"]);
  assert.deepEqual(r.got[0]!.params, { tileId: "hm:t1", event: "input.requested", kind: "permission", sessionId: "s1" });
  assert.deepEqual(r.got[1]!.params, { token: "tok" });
  assert.deepEqual(r.got[2]!.params, { callerTile: "hm:t1", hook: "PermissionRequest", tool: "Bash", input: { command: "npm test" } });
});

test("a hook that answers prints nothing, so the agent's own prompt decides, when the host leaves it to it, refuses, or lets go", async () => {
  for (const reply of [{ result: {} }, { error: { code: -32000, message: "no desktop on this machine" } }, null]) {
    const r = await answering(reply);
    assert.equal(r.printed, "", JSON.stringify(reply));
    assert.equal(r.got.at(-1)!.method, "agent.await_answer");
  }
});
