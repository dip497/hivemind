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
