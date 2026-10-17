// The hook door under bun, as `hive host` runs it: hive-net's `hook` holding an answer through it,
// and the agent ending that hook letting go of the wait on the host.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startHookDoor } from "../src/hooks/hook-door.js";

const HIVE_NET = path.resolve(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const until = async (ok: () => boolean) => { for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

test.skipIf(!fs.existsSync(HIVE_NET))("a held hook is answered through the door, and one the agent ends lets go of the wait", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  const got: string[] = [];
  let closed = 0;
  let answer = true;
  const host = net.createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      for (const l of d.split("\n").filter(Boolean)) {
        const m = JSON.parse(l) as { id?: string; method: string };
        got.push(m.method);
        if (m.method === "agent.await_answer" && answer) c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { stdout: "allow" } })}\n`);
      }
    });
    c.on("close", () => { closed++; });
  });
  await new Promise<void>((r) => host.listen(path.join(dir, "hcp.sock"), r));
  const door = await startHookDoor({ path: path.join(dir, "door.sock"), sock: path.join(dir, "hcp.sock") });
  const run = () => {
    const child = spawn(HIVE_NET, ["hook", door.path], {
      env: { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", HIVE_EVENT: "input.requested", HIVE_EVENT_ANSWER: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let printed = "";
    child.stdout.on("data", (d) => { printed += d; });
    child.stdin.end(JSON.stringify({ tool_name: "Bash" }));
    return { child, printed: () => printed, exited: new Promise((r) => child.on("exit", r)) };
  };

  const answered = run();
  await answered.exited;
  expect(answered.printed()).toBe("allow");
  // The door lets go of the answered wait, but its close can reach the host after the hook exits.
  await until(() => closed === 1);
  expect(closed).toBe(1);

  answer = false;
  got.length = 0;
  const before = closed;
  const held = run();
  await until(() => got.length >= 3);
  await new Promise((r) => setTimeout(r, 100));
  expect(closed).toBe(before);
  held.child.kill("SIGTERM");
  await until(() => closed > before);
  expect(closed).toBe(before + 1);
  door.close();
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hook's line that arrives in pieces is reported whole, as a large payload arrives, signed in as its tile", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  const got: unknown[] = [];
  const host = net.createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (d: string) => { for (const l of d.split("\n").filter(Boolean)) got.push(JSON.parse(l)); });
  });
  await new Promise<void>((r) => host.listen(path.join(dir, "hcp.sock"), r));
  const door = await startHookDoor({ path: path.join(dir, "door.sock"), sock: path.join(dir, "hcp.sock") });
  const line = `${JSON.stringify({ env: { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", HIVE_EVENT: "turn.ended" }, stdin: JSON.stringify({ session_id: "s-1", out: "y".repeat(200_000) }) })}\n`;
  const c = net.connect(door.path);
  await new Promise((r) => c.once("connect", r));
  for (const piece of [line.slice(0, 1000), line.slice(1000, -3), line.slice(-3)]) {
    c.write(piece);
    await new Promise((r) => setTimeout(r, 20));
  }
  await until(() => got.length > 1);
  expect(got).toEqual([
    { jsonrpc: "2.0", method: "initialize", params: { token: "tok" } },
    { jsonrpc: "2.0", method: "agent.event", params: { tileId: "hm:t1", event: "turn.ended", sessionId: "s-1" } },
  ]);
  c.destroy();
  door.close();
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hook that asks for nothing signs in asking for no reply, so the host is left nothing to write and every connection closes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  let closed = 0;
  const host = net.createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      for (const l of d.split("\n").filter(Boolean)) {
        const m = JSON.parse(l) as { id?: string; method: string };
        // As the control plane: a request is answered, a notification never.
        if (m.method === "initialize" && m.id !== undefined) c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 2 } })}\n`);
      }
    });
    c.on("close", () => { closed++; });
  });
  await new Promise<void>((r) => host.listen(path.join(dir, "hcp.sock"), r));
  const door = await startHookDoor({ path: path.join(dir, "door.sock"), sock: path.join(dir, "hcp.sock") });
  try {
    for (const event of ["turn.started", "input.resolved", "turn.ended"]) {
      const c = net.connect(door.path);
      c.on("data", () => {});
      await new Promise((r) => c.once("connect", r));
      c.end(`${JSON.stringify({ env: { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", HIVE_EVENT: event }, stdin: "{}" })}\n`);
      await new Promise((r) => c.once("close", r));
    }
    await until(() => closed === 3);
    expect(closed).toBe(3);
  } finally {
    door.close();
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
