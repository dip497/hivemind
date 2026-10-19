/**
 * HCP client for the `hive ctl` verbs of the agent channel — one short-lived JSON-RPC
 * connection per request to the running app's control-plane socket.
 *
 * Socket + token come from env (HIVE_HCP_SOCK / HCP_TOKEN — injected into every
 * agent hivemind spawns) else the app's data folder (app-data.ts).
 *
 * Errors are structured: `HcpCliError { code, message, exit, fix? }`, printed and exited with as
 * exit-codes.ts says.
 */
import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultToken } from "hivemind-api";
import type { Where } from "@hivemind/core/app-data";
import { appSocket } from "./app-data.js";
import { EXIT, exitCodeFor } from "./exit-codes.js";

export class HcpCliError extends Error {
  constructor(public code: string, message: string, public exit: number, public fix?: string) {
    super(message);
    this.name = "HcpCliError";
  }
}

/** The app's control plane: `HIVE_HCP_SOCK`, given every agent, else the app's own. */
export function sockPath(where: Where = {}): string {
  return appSocket("hcp.sock", "HIVE_HCP_SOCK", where);
}

/** This process's own tile id when it runs inside a hivemind-spawned agent. */
export function ownTile(): string | undefined {
  return process.env.HIVEMIND_TILE || undefined;
}

type ServerMsg = {
  id?: string | number | null; method?: string; result?: unknown; params?: unknown;
  error?: { code?: number; message?: string; data?: { code?: string } };
};

function unavailable(msg: string): HcpCliError {
  return new HcpCliError("UNAVAILABLE", msg, EXIT.unavailable);
}

function rpcError(m: ServerMsg): HcpCliError {
  const code = m.error?.data?.code || (m.error?.code === -32601 ? "UNKNOWN_METHOD" : "FAILED");
  return new HcpCliError(code, m.error?.message || code, exitCodeFor(code));
}

/** A connection that has introduced itself: `initialize` with the token, then `first`. */
function open(first: { id: string; method: string; params: unknown }, onMessage: (m: ServerMsg) => void, onDone: (e?: Error) => void): net.Socket {
  const c = net.connect(sockPath(), () => {
    try {
      c.write(JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { token: defaultToken() } }) + "\n"
        + JSON.stringify({ jsonrpc: "2.0", ...first }) + "\n");
    } catch (e) { onDone(unavailable((e as Error).message)); }
  });
  c.setEncoding("utf8");
  let buf = "";
  c.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m: ServerMsg;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === "init") { if (m.error) onDone(rpcError(m)); continue; }
      onMessage(m);
    }
  });
  c.on("error", (e: Error) => onDone(unavailable(`hivemind app not reachable: ${e.message}`)));
  return c;
}

/** A call names the tile it comes from when it runs in one: the app records that tile as who
 *  asked. A call that names a tile itself (`report --tile`) keeps it. */
function fromOwnTile(params: unknown): unknown {
  const tile = ownTile();
  if (!tile || !params || typeof params !== "object" || Array.isArray(params)) return params;
  const named = params as { callerTile?: unknown };
  return { ...named, callerTile: named.callerTile ?? tile };
}

/** One request. `timeoutMs` is the WIRE ceiling for this single round trip —
 *  keep it short and loop (see `read`), never one long request: the caller's
 *  own tool timeout (Claude Code's Bash tool: 120 s) is usually the tighter
 *  bound and a long request just dies silently at it. */
export function hcpCall(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
  const sock = sockPath();
  if (!fs.existsSync(sock)) return Promise.reject(unavailable(`hivemind app not running (no socket at ${sock})`));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let settled = false;
    const timer = setTimeout(() => fail(new HcpCliError("TIMEOUT", `HCP request timed out after ${timeoutMs} ms`, EXIT.timeout)), timeoutMs);
    function ok(v: unknown) { if (settled) return; settled = true; clearTimeout(timer); try { c.end(); } catch { /* */ } resolve(v); }
    function fail(e: Error) { if (settled) return; settled = true; clearTimeout(timer); try { c.destroy(); } catch { /* */ } reject(e); }
    const c = open({ id, method, params: fromOwnTile(params) }, (m) => {
      if (m.id !== id) return;
      if (m.error) fail(rpcError(m)); else ok(m.result);
    }, (e) => fail(e ?? unavailable("HCP connection closed")));
    c.on("close", () => fail(unavailable("HCP connection closed before a reply")));
  });
}
