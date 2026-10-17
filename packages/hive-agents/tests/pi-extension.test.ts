// pi's bridge extension (fixtures/published-agents/pi/hive-pi-ext.mjs), loaded as pi loads it:
// its orchestration tools are `hive ctl … --json`, each answering what the CLI printed, a result
// printed with a failing exit (a read that timed out) included; a failure says why; and a turn's
// reply goes to the control plane on the tile's token before the turn end.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-")));
const argvLog = path.join(dir, "argv.jsonl");
const sock = path.join(dir, "hcp.sock");
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }> };
const tools: Record<string, Tool> = {};
const handlers: Record<string, (event: unknown) => Promise<void>> = {};
const heard: string[] = [];
let server: net.Server;
const env = { PATH: process.env.PATH, HIVE_HCP_SOCK: process.env.HIVE_HCP_SOCK, HIVEMIND_TILE: process.env.HIVEMIND_TILE, HCP_TOKEN: process.env.HCP_TOKEN };

beforeAll(async () => {
  // Loaded beside a stand-in for the typebox pi bundles.
  fs.copyFileSync(path.join(import.meta.dir, "fixtures", "published-agents", "pi", "hive-pi-ext.mjs"), path.join(dir, "ext.mjs"));
  fs.mkdirSync(path.join(dir, "node_modules", "typebox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(dir, "node_modules", "typebox", "index.js"), "const t = (...a) => a; export const Type = new Proxy({}, { get: () => t });\n");
  // A `hive` that keeps what it was run with, and prints what the real one would.
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "hive"), `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[1] === "read") { console.log(JSON.stringify({ text: null, finalStatus: "timeout", truncated: false })); process.exit(4); }
if (args[1] === "close") { console.log(JSON.stringify({ ok: false, code: "NOT_FOUND", message: "no agent runs in tile ghost" })); process.exit(5); }
console.log(JSON.stringify({ tile: "w-1" }));
`, { mode: 0o755 });
  // The control plane: it keeps what it hears and answers each request.
  server = net.createServer((c) => c.on("data", (d) => {
    for (const line of String(d).split("\n").filter(Boolean)) {
      heard.push(line);
      const m = JSON.parse(line) as { id?: string };
      if (m.id) c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } })}\n`);
    }
  })).listen(sock);
  await new Promise((r) => server.once("listening", r));
  Object.assign(process.env, { PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`, HIVE_HCP_SOCK: sock, HIVEMIND_TILE: "hm:me", HCP_TOKEN: "tok" });
  const ext = (await import(path.join(dir, "ext.mjs"))).default as (pi: unknown) => void;
  ext({ on: (event: string, h: (e: unknown) => Promise<void>) => { handlers[event] = h; }, registerTool: (t: Tool) => { tools[t.name] = t; } });
});
afterAll(() => {
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ran = (): string[][] => fs.readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const run = (name: string, params: Record<string, unknown>) => tools[name]!.execute("call-1", params);

test("each tool is hive ctl, with --json, its params as the CLI takes them", async () => {
  expect((await run("hive_spawn_agent", { agent: "claude", name: "rev", prompt: "review it\nthen fix it", supervise: ["Bash", "Edit"] })).details).toEqual({ tile: "w-1" });
  await run("hive_send", { tileId: "w-1", text: "also\nthe tests" });
  await run("hive_send_keys", { tileId: "w-1", keys: ["Down", "Enter"] });
  await run("hive_disconnect", { srcTileId: "w-1" });
  await run("hive_approve", { reqId: "req-1", decision: "always" });
  await run("hive_workflow", { shape: "fanout", items: ["a", "b"], prompt: "do {item}", timeout_ms: 90_000, close_when_done: true });
  await run("hive_list_agents", {});
  expect(ran()).toEqual([
    ["ctl", "spawn", "--agent", "claude", "--name", "rev", "--prompt", "review it\nthen fix it", "--supervise", "Bash,Edit", "--json"],
    ["ctl", "send", "w-1", "also\nthe tests", "--json"],
    ["ctl", "keys", "w-1", "Down,Enter", "--json"],
    ["ctl", "disconnect", "w-1", "--json"],
    ["ctl", "approve", "req-1", "always", "--json"],
    ["ctl", "workflow", "--shape", "fanout", "--items", "a||b", "--prompt", "do {item}", "--timeout", "90000ms", "--close", "--json"],
    ["ctl", "agents", "--json"],
  ]);
});

test("a result printed with a failing exit is the answer; a failure says why", async () => {
  const read = await run("hive_read", { tileId: "w-1", timeout_ms: 1500 });
  expect(ran().at(-1)).toEqual(["ctl", "read", "w-1", "--timeout", "1500ms", "--json"]);
  expect(read.details).toEqual({ text: null, finalStatus: "timeout", truncated: false });
  const closed = await run("hive_close_tile", { tileId: "ghost" });
  expect(closed.details).toEqual({ error: "no agent runs in tile ghost" });
  expect(closed.content[0]!.text).toBe("hive error: no agent runs in tile ghost");
});

test("every connection signs in with the tile's token first; a turn's reply goes before the turn end", async () => {
  await handlers.agent_start!({});
  await handlers.message_end!({ message: { role: "assistant", content: [{ type: "text", text: "all done" }] } });
  await handlers.agent_end!({});
  for (let i = 0; i < 100 && !heard.some((l) => l.includes("turn.ended")); i++) await new Promise((r) => setTimeout(r, 10));
  expect(heard.map((l) => JSON.parse(l)).map((m) => [m.method, m.params])).toEqual([
    ["initialize", { token: "tok" }],
    ["agent.event", { tileId: "hm:me", event: "turn.started" }],
    ["initialize", { token: "tok" }],
    ["agent.reply", { tileId: "hm:me", text: "all done" }],
    ["initialize", { token: "tok" }],
    ["agent.event", { tileId: "hm:me", event: "turn.ended" }],
  ]);
});
