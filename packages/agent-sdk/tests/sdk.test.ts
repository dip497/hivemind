// The SDK run for real: a node process loads the written file and talks to a fake host socket.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SDK_ENV, SDK_FILE, sdkSource } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

type Line = Record<string, unknown>;
/** A host that records every line and answers requests with `answer`. */
async function host(dir: string, name: string, answer: (m: Line) => Line | null) {
  const sock = path.join(dir, name);
  const got: Line[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Line; buf = buf.slice(nl + 1);
        got.push(m);
        const res = answer(m);
        if (res) c.write(JSON.stringify(res) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  return { sock, got, close: () => server.close() };
}

/** Run `body` (an async function body with `hive` in scope) with the payload on stdin. */
async function run(body: string, env: Record<string, string>, payload: unknown = {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-")); dirs.push(dir);
  fs.writeFileSync(path.join(dir, SDK_FILE), sdkSource());
  const script = path.join(dir, "hook.cjs");
  fs.writeFileSync(script, `const hive = require(process.env.HIVE_SDK);\n(async () => { ${body} })().then(() => process.exit(0));`);
  const child = spawn("node", [script], {
    env: { PATH: process.env.PATH ?? "", [SDK_ENV.sdk]: path.join(dir, SDK_FILE), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => child.on("exit", r));
  return out;
}

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "sdkh-")); dirs.push(d); return d; };

test("payload, emit and reportReply reach the host in order, attributed to the tile", async () => {
  const h = await host(tmp(), "hcp.sock", (m) => (m.t === "req" ? { t: "res", id: m.id, ok: true, result: { ok: true } } : null));
  const out = await run(
    `const p = await hive.payload(); const ok = await hive.reportReply("the reply"); await hive.emit("turn.ended", { background: 2 }); process.stdout.write(JSON.stringify({ p, ok }));`,
    { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", [SDK_ENV.sock]: h.sock },
    { last_assistant_message: "the reply" },
  );
  await new Promise((r) => setTimeout(r, 50));
  h.close();
  expect(JSON.parse(out)).toEqual({ p: { last_assistant_message: "the reply" }, ok: true });
  expect(h.got.map((m) => (m.t === "req" ? m.method : m.topic))).toEqual(["agent.reply", "agent.event"]);
  expect(h.got[0]).toMatchObject({ token: "tok", params: { tileId: "hm:t1", text: "the reply" } });
  expect(h.got[1]).toEqual({ t: "event", topic: "agent.event", data: { background: 2, tileId: "hm:t1", event: "turn.ended" } });
});

test("requestApproval returns the host's decision, and ask when there is none", async () => {
  const h = await host(tmp(), "hcp.sock", (m) => ({ t: "res", id: m.id, ok: true, result: { decision: "deny", reason: "no" } }));
  const env = { HIVEMIND_TILE: "hm:w", [SDK_ENV.sock]: h.sock };
  const out = await run(`process.stdout.write(JSON.stringify(await hive.requestApproval({ tool: "Bash", input: { command: "ls" } })));`, env);
  h.close();
  expect(JSON.parse(out)).toEqual({ decision: "deny", reason: "no" });
  expect(h.got[0]).toMatchObject({ method: "agent.await_approval", params: { callerTile: "hm:w", tool_name: "Bash", tool_input: { command: "ls" } } });
  const none = await run(`process.stdout.write(JSON.stringify(await hive.requestApproval({ tool: "Bash" })));`, { HIVEMIND_TILE: "hm:w", [SDK_ENV.sock]: path.join(tmp(), "gone.sock") });
  expect(JSON.parse(none)).toEqual({ decision: "ask" });
});

test("openPlanReview waits for the bridge's decision; null when nothing answers", async () => {
  const h = await host(tmp(), "plan.sock", () => ({ decision: "deny", feedback: "smaller steps" }));
  const out = await run(`process.stdout.write(JSON.stringify(await hive.openPlanReview({ plan: "# plan", cwd: "/w" })));`, { HIVEMIND_TILE: "hm:t1", [SDK_ENV.planSock]: h.sock });
  h.close();
  expect(JSON.parse(out)).toEqual({ decision: "deny", feedback: "smaller steps" });
  expect(h.got[0]).toEqual({ tileId: "hm:t1", plan: "# plan", cwd: "/w" });
  const none = await run(`process.stdout.write(JSON.stringify(await hive.openPlanReview({ plan: "x", cwd: "/w" })));`, { HIVEMIND_TILE: "hm:t1" });
  expect(none).toBe("null");
});

test("outside a session nothing is sent, and a payload that is not JSON reads as {}", async () => {
  const h = await host(tmp(), "hcp.sock", () => null);
  const out = await run(`await hive.emit("turn.started"); process.stdout.write(JSON.stringify([await hive.reportReply("x"), await hive.payload()]));`, { [SDK_ENV.sock]: h.sock }, "not json");
  await new Promise((r) => setTimeout(r, 50));
  h.close();
  expect(JSON.parse(out)).toEqual([false, {}]);
  expect(h.got).toEqual([]);
});
