// The generic observe hook, run for real against the shared conformance cases through both its
// programs: node executing the generated script, and hive-net's `hook` through the hook door, each
// with an agent's payload on stdin; a unix socket stands in for the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentEventHookSource } from "@hivemind/agent-host/hooks/agent-event-hook-source";
import { startHookDoor } from "@hivemind/agent-host/hooks/hook-door";
import { EVENT_ENV, keptFields } from "@hivemind/agents";

interface Case { name: string; env: Record<string, string>; payload: unknown; expect: unknown; forbidden?: string[] }
const casesFile = fileURLToPath(new URL("../../../../conformance/hook-reports.json", import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(casesFile, "utf8")) as { cases: Case[] };
const HIVE_NET = path.resolve(import.meta.dirname, "../../../../crates/hive-net/target/debug/hive-net");
const noHiveNet = !fs.existsSync(HIVE_NET) && "build hive-net first: cargo build in crates/hive-net";

type Via = "script" | "native";
const VIAS: Via[] = ["script", "native"];

/** The agent's hook, run through `via` with `env` in front of it and `payload` on stdin, reporting
 *  to the host on `sock`. It is told the payload's keys to keep as a launch tells it. */
async function hook(via: Via, sock: string, entryEnv: Record<string, string>, payload: unknown) {
  const env = { [EVENT_ENV.keep]: keptFields({ answer: entryEnv[EVENT_ENV.answer] === "1" }), ...entryEnv };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evh-"));
  const door = via === "native" ? await startHookDoor({ path: path.join(dir, "door.sock"), sock }) : undefined;
  const script = path.join(dir, "hook.cjs");
  fs.writeFileSync(script, agentEventHookSource());
  const child = door
    ? spawn(HIVE_NET, ["hook", door.path], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "ignore"] })
    : spawn(process.execPath, [script, sock], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let printed = "";
  child.stdout!.on("data", (d) => { printed += d; });
  child.stdin!.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  const exited = new Promise<number | null>((r) => child.on("exit", r)).finally(() => {
    door?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { child, exited, printed: () => printed };
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

const until = async (ok: () => boolean) => { for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

for (const via of VIAS) for (const c of cases) {
  test(`${c.name} (${via})`, { skip: via === "native" && noHiveNet }, async () => {
    const h = await host();
    const r = await hook(via, h.sock, c.env, c.payload);
    assert.equal(await r.exited, 0, "a hook always exits 0 so the agent never waits on us");
    await new Promise((res) => setTimeout(res, 50));
    h.close();
    assert.equal(r.printed(), "", "an event that asks for nothing prints nothing");
    assert.deepEqual(h.got, c.expect === null ? [] : [{ jsonrpc: "2.0", method: "agent.event", params: c.expect }]);
    for (const f of c.forbidden ?? []) assert.ok(!JSON.stringify(h.got).includes(f), `"${f}" must not leave the hook`);
  });
}

const ASKS = { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", HIVE_EVENT: "input.requested", HIVE_EVENT_KIND: "permission", HIVE_EVENT_ANSWER: "1" };
const PERMISSION = { hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } };

/** The hook run as an entry that answers, against a host that answers its `agent.await_answer`
 *  with `reply`: every line the host got, and what the hook printed. */
async function answering(via: Via, reply: { result: unknown } | { error: unknown } | null): Promise<{ got: Array<Record<string, unknown>>; printed: string }> {
  const h = await host(reply);
  const r = await hook(via, h.sock, ASKS, PERMISSION);
  assert.equal(await r.exited, 0, "a hook always exits 0");
  h.close();
  return { got: h.got, printed: r.printed() };
}

for (const via of VIAS) {
  const skip = via === "native" && noHiveNet;
  test(`a hook that answers reports its event, then asks for the answer on the same connection, as its tile, and prints what the host answers (${via})`, { skip }, async () => {
    const printed = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    const r = await answering(via, { result: { stdout: printed } });
    assert.equal(r.printed, printed);
    assert.deepEqual(r.got.map((m) => m.method), ["agent.event", "initialize", "agent.await_answer"]);
    assert.deepEqual(r.got[0]!.params, { tileId: "hm:t1", event: "input.requested", kind: "permission", sessionId: "s1" });
    assert.deepEqual(r.got[1]!.params, { token: "tok" });
    assert.deepEqual(r.got[2]!.params, { callerTile: "hm:t1", hook: "PermissionRequest", tool: "Bash", input: { command: "npm test" } });
  });

  test(`a hook that answers prints nothing, so the agent's own prompt decides, when the host leaves it to it, refuses, or lets go (${via})`, { skip }, async () => {
    for (const reply of [{ result: {} }, { error: { code: -32000, message: "no desktop on this machine" } }, null]) {
      const r = await answering(via, reply);
      assert.equal(r.printed, "", JSON.stringify(reply));
      assert.equal(r.got.at(-1)!.method, "agent.await_answer");
    }
  });

  test(`the agent ending a held hook (its own prompt answered, Esc, its timeout) lets go of the wait on the host (${via})`, { skip }, async () => {
    const h = await host();
    const r = await hook(via, h.sock, ASKS, PERMISSION);
    await until(() => h.got.length >= 3);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(h.closed(), 0, "held while the agent waits");
    (r.child as ChildProcess).kill("SIGTERM");
    await r.exited;
    await until(() => h.closed() > 0);
    assert.equal(h.closed(), 1);
    h.close();
  });
}
