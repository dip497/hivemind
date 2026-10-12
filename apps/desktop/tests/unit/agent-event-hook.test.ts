// The generic observe hook, run for real against the shared conformance cases through both its
// doors: node executes the generated script with an agent's payload on stdin, or the payload is
// POSTed to the http front as an agent's http hook does; a unix socket stands in for the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { agentEventHookSource } from "@hivemind/agent-host/hooks/agent-event-hook-source";
import { startHookHttp } from "@hivemind/agent-host/hooks/hook-http";

interface Case { name: string; env: Record<string, string>; payload: unknown; expect: unknown; forbidden?: string[] }
const casesFile = fileURLToPath(new URL("../../../../conformance/hook-reports.json", import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(casesFile, "utf8")) as { cases: Case[] };

type Door = "script" | "http";

/** The agent's hook through `door`: `env` as the host put it in front of the command (for http,
 *  the url's query and the headers the manifest's http entry sends), `payload` as the agent sent it.
 *  What it printed, and its exit code or http status. */
async function hook(door: Door, sock: string, env: Record<string, string>, payload: unknown): Promise<{ printed: string; code: number | null }> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (door === "script") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evh-"));
    const script = path.join(dir, "hook.cjs");
    fs.writeFileSync(script, agentEventHookSource());
    const child = spawn(process.execPath, [script, sock], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let printed = "";
    child.stdout.on("data", (d) => { printed += d; });
    child.stdin.end(body);
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
    return { printed, code };
  }
  const front = await startHookHttp({ sock, tileOf: (token) => token === env.HCP_TOKEN ? env.HIVEMIND_TILE : undefined });
  const query = new URLSearchParams(Object.entries({ event: env.HIVE_EVENT, kind: env.HIVE_EVENT_KIND, outcome: env.HIVE_EVENT_OUTCOME, answer: env.HIVE_EVENT_ANSWER })
    .filter((kv): kv is [string, string] => !!kv[1]));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(`${front.url}/event?${query}`, { method: "POST", headers: { authorization: `Bearer ${env.HCP_TOKEN ?? ""}` } }, (res) => {
        let printed = "";
        res.on("data", (d) => { printed += d; });
        res.on("end", () => resolve({ printed, code: res.statusCode ?? null }));
      });
      req.on("error", reject);
      req.end(body);
    });
  } finally { front.close(); }
}

/** A host on a unix socket: every line it got, answering an `agent.await_answer` with `reply` (a
 *  result or an error; null: it closes the connection; undefined: it never answers). */
async function host(reply?: { result: unknown } | { error: unknown } | null) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evh-")), "s.sock");
  const got: Array<Record<string, unknown>> = [];
  let closed = 0;
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
        if (m.method !== "agent.await_answer" || reply === undefined) continue;
        if (reply === null) c.destroy();
        else c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, ...reply })}\n`);
      }
    });
    c.on("close", () => { closed++; });
    c.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(sock, r));
  return { sock, got, closed: () => closed, close: () => server.close() };
}

const DOORS: Door[] = ["script", "http"];
const OK: Record<Door, number> = { script: 0, http: 200 };

for (const door of DOORS) for (const c of cases) {
  test(`${c.name} (${door})`, async () => {
    const h = await host();
    const r = await hook(door, h.sock, { HCP_TOKEN: "tok", ...c.env }, c.payload);
    await new Promise((res) => setTimeout(res, 50));
    h.close();
    if (door === "script") assert.equal(r.code, 0, "a hook always exits 0 so the agent never waits on us");
    else assert.equal(r.printed, "", "an event that asks for nothing is answered empty");
    assert.deepEqual(h.got, c.expect === null ? [] : [{ jsonrpc: "2.0", method: "agent.event", params: c.expect }]);
    for (const f of c.forbidden ?? []) assert.ok(!JSON.stringify(h.got).includes(f), `"${f}" must not leave the hook`);
  });
}

/** The hook run as an entry that answers (`HIVE_EVENT_ANSWER=1`, `answer=1`), against a host that
 *  answers its `agent.await_answer` with `reply`: every line the host got, and what the hook printed. */
async function answering(door: Door, reply: { result: unknown } | { error: unknown } | null): Promise<{ got: Array<Record<string, unknown>>; printed: string }> {
  const h = await host(reply);
  const env = { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", HIVE_EVENT: "input.requested", HIVE_EVENT_KIND: "permission", HIVE_EVENT_ANSWER: "1" };
  const r = await hook(door, h.sock, env, { hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } });
  h.close();
  assert.equal(r.code, OK[door], "a hook always succeeds, so the agent never fails on us");
  return { got: h.got, printed: r.printed };
}

for (const door of DOORS) {
  test(`a hook that answers reports its event, then asks for the answer on the same connection, as its tile, and prints what the host answers (${door})`, async () => {
    const printed = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    const r = await answering(door, { result: { stdout: printed } });
    assert.equal(r.printed, printed);
    assert.deepEqual(r.got.map((m) => m.method), ["agent.event", "initialize", "agent.await_answer"]);
    assert.deepEqual(r.got[0]!.params, { tileId: "hm:t1", event: "input.requested", kind: "permission", sessionId: "s1" });
    assert.deepEqual(r.got[1]!.params, { token: "tok" });
    assert.deepEqual(r.got[2]!.params, { callerTile: "hm:t1", hook: "PermissionRequest", tool: "Bash", input: { command: "npm test" } });
  });

  test(`a hook that answers prints nothing, so the agent's own prompt decides, when the host leaves it to it, refuses, or lets go (${door})`, async () => {
    for (const reply of [{ result: {} }, { error: { code: -32000, message: "no desktop on this machine" } }, null]) {
      const r = await answering(door, reply);
      assert.equal(r.printed, "", JSON.stringify(reply));
      assert.equal(r.got.at(-1)!.method, "agent.await_answer");
    }
  });
}

test("over http, the agent giving up on its hook (Esc) lets go of the wait on the host", async () => {
  const h = await host();
  const front = await startHookHttp({ sock: h.sock, tileOf: () => "t1" });
  const { port } = new URL(front.url);
  const body = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
  const agent = net.connect(Number(port), "127.0.0.1", () => agent.write(
    `POST /event?event=input.requested&answer=1 HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nauthorization: Bearer tok\r\ncontent-length: ${body.length}\r\n\r\n${body}`));
  for (let i = 0; i < 200 && h.got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.closed(), 0, "held while the agent waits");
  agent.destroy();
  for (let i = 0; i < 200 && h.closed() === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.closed(), 1);
  front.close(); h.close();
});

test("over http, a request without the tile's own token, from a page in a browser, or to another host name is refused, and nothing reaches the host", async () => {
  const h = await host({ result: { stdout: "{}" } });
  const front = await startHookHttp({ sock: h.sock, tileOf: (token) => (token === "t1.mac" ? "t1" : undefined) });
  const status = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = http.request(`${front.url}/event?event=input.requested&answer=1`, { method: "POST", headers: { authorization: "Bearer t1.mac", ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(await status({}), 200, "the tile's own token is let in");
  const before = h.got.length;
  assert.equal(await status({ authorization: "Bearer t2.forged" }), 403);
  assert.equal(await status({ origin: "https://evil.example" }), 404);
  assert.equal(await status({ host: "evil.example" }), 404);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.got.length, before);
  front.close(); h.close();
});
