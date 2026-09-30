/**
 * The SDK an agent plugin's hook scripts use to talk to the host. The host writes it to disk
 * beside its own scripts and names it in `HIVE_SDK`; a plugin script loads it with
 * `require(process.env.HIVE_SDK)`, so a plugin never bundles a copy and always speaks the
 * protocol of the host it runs under. Wire format: `spec/hook-protocol.md`.
 */

export const SDK_FILE = "hive-sdk.cjs";
export const SDK_VERSION = "0.1";

/** Environment the host puts in front of every plugin hook command. */
export const SDK_ENV = { sdk: "HIVE_SDK", sock: "HIVE_HOOK_SOCK", planSock: "HIVE_PLAN_SOCK" } as const;

/** What `require(process.env.HIVE_SDK)` returns. */
export interface HiveSdk {
  version: string;
  /** The session this hook runs for, or "" outside one. */
  tile: string;
  /** The agent's hook payload from stdin; `{}` when there is none or it is not JSON. */
  payload(): Promise<Record<string, unknown>>;
  /** Report a canonical event. Fields beyond the spec's are dropped by the host. */
  emit(event: string, fields?: Record<string, unknown>): Promise<void>;
  /** Hand the host this turn's reply, for `hive ctl read`. Send it before `turn.ended`. */
  reportReply(text: string): Promise<boolean>;
  /** Ask the supervising agent. `ask` means nobody decided. */
  requestApproval(req: { tool: string; input: unknown }): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }>;
  /** Open the plan beside the session and wait for the person. `null` when no review UI answered. */
  openPlanReview(req: { plan: string; cwd: string }): Promise<{ decision: "approve" | "deny"; feedback?: string } | null>;
}

export function sdkSource(): string {
  return `// Written by the hivemind host. Load with require(process.env.HIVE_SDK).
"use strict";
const net = require("net");
const env = process.env;
const tile = env.HIVEMIND_TILE || "";
const sock = env.${SDK_ENV.sock} || "";
const planSock = env.${SDK_ENV.planSock} || "";
const token = env.HCP_TOKEN || "";

let payloadP = null;
function payload() {
  if (payloadP) return payloadP;
  payloadP = new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { input += d; });
    process.stdin.on("error", () => resolve({}));
    process.stdin.on("end", () => {
      try { const v = JSON.parse(input); resolve(v && typeof v === "object" ? v : {}); } catch (e) { resolve({}); }
    });
  });
  return payloadP;
}

// Lines out; with an id, wait for the reply that carries it (null: take the first line back).
// Never rejects.
function send(path, msgs, id, timeoutMs) {
  return new Promise((resolve) => {
    if (!path) return resolve(null);
    let done = false, buf = "";
    const finish = (v) => { if (done) return; done = true; try { c.end(); } catch (e) {} resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs); if (t.unref) t.unref();
    const c = net.connect(path, () => {
      try { c.write(msgs.map((m) => JSON.stringify(m) + "\\n").join(""), () => { if (id === undefined) finish(true); }); } catch (e) { finish(null); }
    });
    c.setEncoding("utf8");
    c.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (id === null) return finish(m);
        if (m && m.id === id) return finish(m);
      }
    });
    c.on("error", () => finish(null));
    c.on("close", () => finish(null));
  });
}

let seq = 0;
const reqId = () => "sdk_" + process.pid + "_" + (++seq) + "_" + Math.floor(Math.random() * 1e9);
// JSON-RPC 2.0: introduce this connection with the token, then ask.
function request(method, params, timeoutMs) {
  const id = reqId();
  return send(sock, [
    { jsonrpc: "2.0", id: id + "_init", method: "initialize", params: { token: token } },
    { jsonrpc: "2.0", id: id, method: method, params: params },
  ], id, timeoutMs);
}

module.exports = {
  version: ${JSON.stringify(SDK_VERSION)},
  tile: tile,
  payload: payload,
  emit: async (event, fields) => {
    if (!tile || typeof event !== "string") return;
    await send(sock, [{ jsonrpc: "2.0", method: "agent.event", params: Object.assign({}, fields || {}, { tileId: tile, event: event }) }], undefined, 2000);
  },
  reportReply: async (text) => {
    if (!tile || typeof text !== "string" || !text) return false;
    const m = await request("agent.reply", { tileId: tile, text: text }, 5000);
    return !!(m && !m.error);
  },
  requestApproval: async (req) => {
    const m = await request("agent.await_approval", { callerTile: tile, tool_name: req && req.tool, tool_input: (req && req.input) || {} }, 9 * 60 * 1000);
    const d = m && m.result && m.result.decision;
    return d === "allow" || d === "deny" ? { decision: d, reason: m.result.reason } : { decision: "ask" };
  },
  openPlanReview: async (req) => {
    const m = await send(planSock, [{ tileId: tile, plan: req && req.plan, cwd: req && req.cwd }], null, 4 * 24 * 3600 * 1000);
    if (!m) return null;
    return m.decision === "deny" ? { decision: "deny", feedback: m.feedback } : { decision: "approve" };
  },
};
`;
}
