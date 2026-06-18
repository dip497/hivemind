/**
 * `hive ctl` — drive the RUNNING hivemind desktop app from the shell via the
 * Hivemind Control Plane (HCP): spawn agents on the canvas, send them input,
 * read their replies, list/focus/close tiles, and pipe agents together.
 *
 * Talks to the same 0600 unix socket the hive MCP uses. Socket + token come from
 * env (HIVE_HCP_SOCK / HCP_TOKEN) when run inside a hivemind agent, else the
 * well-known userData path (<config>/hivemind/hcp.{sock,token}).
 */
import { defineCommand } from "citty";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function configDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}
function sockPath(): string {
  return process.env.HIVE_HCP_SOCK || path.join(configDir(), "hivemind", "hcp.sock");
}
function token(): string {
  if (process.env.HCP_TOKEN) return process.env.HCP_TOKEN;
  try {
    return fs.readFileSync(path.join(configDir(), "hivemind", "hcp.token"), "utf8").trim();
  } catch {
    return "";
  }
}

function call(method: string, params: unknown, timeoutMs = 130_000): Promise<unknown> {
  const sock = sockPath();
  if (!fs.existsSync(sock)) {
    return Promise.reject(new Error(`hivemind app not running (no socket at ${sock})`));
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buf = "";
    let settled = false;
    const c = net.connect(sock, () => c.write(JSON.stringify({ t: "req", id, method, params, token: token() }) + "\n"));
    c.setEncoding("utf8");
    const timer = setTimeout(() => fail(new Error("HCP request timed out")), timeoutMs);
    function ok(v: unknown) { if (settled) return; settled = true; clearTimeout(timer); try { c.end(); } catch { /* */ } resolve(v); }
    function fail(e: Error) { if (settled) return; settled = true; clearTimeout(timer); try { c.destroy(); } catch { /* */ } reject(e); }
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: { t?: string; id?: string; ok?: boolean; result?: unknown; error?: { message?: string; code?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === "hello") continue;
        if (m.t === "res" && m.id === id) return m.ok ? ok(m.result) : fail(new Error(m.error?.message || m.error?.code || "HCP error"));
      }
    });
    c.on("error", (e: Error) => fail(new Error(`hivemind app not reachable: ${e.message}`)));
    c.on("close", () => fail(new Error("HCP connection closed before a reply")));
  });
}

async function run(method: string, params: unknown, timeoutMs?: number): Promise<void> {
  try {
    const r = await call(method, params, timeoutMs);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const list = defineCommand({
  meta: { name: "list", description: "List tiles on the canvas grouped by frame (with agent status)" },
  args: { frame: { type: "string", description: "filter to one frame (id, repo name, or title)" } },
  async run({ args }) { await run("tile.list", { frame: args.frame }); },
});
const spawn = defineCommand({
  meta: { name: "spawn", description: "Spawn an agent tile; prints its tileId" },
  args: {
    agent: { type: "string", description: "agent id (claude, codex, …)", default: "claude" },
    prompt: { type: "string", description: "initial task" },
    frame: { type: "string", description: "frame to spawn into (id, repo/worktree name, or title)" },
    mode: { type: "string", description: "claude permission mode" },
    supervise: { type: "string", description: "broker the worker's tool permissions to this CLI/agent: 'all', or a comma-list of tools" },
  },
  async run({ args }) { await run("tile.spawn_agent", { agent: args.agent, prompt: args.prompt, frame: args.frame, mode: args.mode, supervise: args.supervise }); },
});
const frames = defineCommand({
  meta: { name: "frames", description: "List canvas frames (id, title, repo, branch, tile count)" },
  async run() { await run("tile.list_frames", {}); },
});
const send = defineCommand({
  meta: { name: "send", description: "Send text to an agent tile" },
  args: { tileId: { type: "positional", required: true }, text: { type: "positional", required: true } },
  async run({ args }) { await run("agent.send", { tileId: args.tileId, text: args.text }); },
});
const keys = defineCommand({
  meta: { name: "keys", description: "Send key tokens to a tile's TUI (comma-separated, e.g. Down,Enter)" },
  args: {
    tileId: { type: "positional", required: true },
    keys: { type: "positional", required: true, description: "comma-separated tokens: Down,Enter,Esc,Tab,1,…" },
  },
  async run({ args }) {
    await run("agent.send_keys", { tileId: args.tileId, keys: String(args.keys).split(",").map((s) => s.trim()).filter(Boolean) });
  },
});
const read = defineCommand({
  meta: { name: "read", description: "Block until an agent finishes its turn; print its reply" },
  args: { tileId: { type: "positional", required: true }, timeout: { type: "string", description: "ms" } },
  async run({ args }) { await run("agent.read", { tileId: args.tileId, timeoutMs: args.timeout ? Number(args.timeout) : undefined }); },
});
const focus = defineCommand({
  meta: { name: "focus", description: "Focus a tile" },
  args: { tileId: { type: "positional", required: true } },
  async run({ args }) { await run("tile.focus", { tileId: args.tileId }); },
});
const close = defineCommand({
  meta: { name: "close", description: "Close a tile" },
  args: { tileId: { type: "positional", required: true } },
  async run({ args }) { await run("tile.close", { tileId: args.tileId }); },
});
const connect = defineCommand({
  meta: { name: "connect", description: "Pipe src agent's replies into dst agent's input" },
  args: { src: { type: "positional", required: true }, dst: { type: "positional", required: true } },
  async run({ args }) { await run("tile.connect", { srcTileId: args.src, dstTileId: args.dst }); },
});
const disconnect = defineCommand({
  meta: { name: "disconnect", description: "Remove pipes from src (optionally to one dst)" },
  args: { src: { type: "positional", required: true }, dst: { type: "positional" } },
  async run({ args }) { await run("tile.disconnect", { srcTileId: args.src, dstTileId: args.dst }); },
});

const approve = defineCommand({
  meta: { name: "approve", description: "Answer a supervised worker's approval request" },
  args: {
    reqId: { type: "positional", required: true },
    decision: { type: "positional", required: true, description: "allow | deny | always | never" },
    reason: { type: "string" },
  },
  async run({ args }) { await run("agent.approve", { reqId: args.reqId, decision: args.decision, reason: args.reason }); },
});

const stream = defineCommand({
  meta: { name: "stream", description: "Stream an agent tile's live output to stdout (Ctrl-C to stop)" },
  args: { tileId: { type: "positional", required: true } },
  run({ args }) {
    const sock = sockPath();
    if (!fs.existsSync(sock)) { console.error(`hivemind app not running (no socket at ${sock})`); process.exit(1); }
    const subId = randomUUID();
    const c = net.connect(sock, () =>
      c.write(JSON.stringify({ t: "sub", id: subId, topic: "agent.stream", params: { tileId: args.tileId }, token: token() }) + "\n"),
    );
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: { t?: string; id?: string; subId?: string; ok?: boolean; data?: { chunk?: string }; error?: { message?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === "evt" && m.subId === subId) process.stdout.write(m.data?.chunk ?? "");
        else if (m.t === "res" && m.id === subId && m.ok === false) { console.error(m.error?.message); process.exit(1); }
      }
    });
    c.on("error", (e: Error) => { console.error(`hivemind app not reachable: ${e.message}`); process.exit(1); });
    c.on("close", () => process.exit(0));
    process.on("SIGINT", () => { try { c.write(JSON.stringify({ t: "unsub", id: subId }) + "\n"); c.end(); } catch { /* */ } process.exit(0); });
  },
});

export const ctlCmd = defineCommand({
  meta: { name: "ctl", description: "Drive the running hivemind app (spawn/send/read/stream/connect agents)" },
  subCommands: { list, frames, spawn, send, keys, read, approve, stream, focus, close, connect, disconnect },
});
