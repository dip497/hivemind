/**
 * HCP client for `hive ctl` — one short-lived JSON-RPC connection per request
 * to the running desktop app's control-plane socket, plus a subscription helper
 * for `agent.stream`.
 *
 * Socket + token come from env (HIVE_HCP_SOCK / HCP_TOKEN — injected into every
 * agent hivemind spawns) else the app's data folder (app-data.ts).
 *
 * Errors are structured: `HcpCliError { code, message, exit }` so every ctl
 * subcommand prints `{ ok:false, code, message }` and exits with a meaningful
 * status an agent can branch on (see EXIT).
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appData, appSocket, envGet, type Where } from "./app-data.js";

/** Exit codes — stable, documented in the hivemind skill. */
export const EXIT = {
  ok: 0,
  /** Unexpected failure / server FAILED. */
  error: 1,
  /** Bad arguments (client-side) or BAD_REQUEST / UNKNOWN_METHOD from the server. */
  usage: 2,
  /** The desktop app is not running / socket unreachable / renderer not up. */
  unavailable: 3,
  /** The wait (read / open-review / workflow) ran out of time. */
  timeout: 4,
  /** NOT_FOUND: a tile, frame, issue or workspace that is not there. */
  notFound: 5,
  /** FORBIDDEN — a bad or missing token, or a call the caller may not make. */
  unauthorized: 6,
  /** RATE_LIMITED / DEPTH_EXCEEDED — the control plane refused for now — or
   *  UNSUPPORTED: the provider lacks the capability (no turn signal, no
   *  permission system) so the verb cannot succeed for it. */
  refused: 7,
} as const;

export class HcpCliError extends Error {
  constructor(public code: string, message: string, public exit: number) {
    super(message);
    this.name = "HcpCliError";
  }
}

/** Map a server error code to a CLI exit status. */
export function exitCodeFor(code: string): number {
  switch (code) {
    case "BAD_REQUEST": case "UNKNOWN_METHOD": case "USAGE": return EXIT.usage;
    case "UNAVAILABLE": return EXIT.unavailable;
    case "TIMEOUT": return EXIT.timeout;
    case "NOT_FOUND": return EXIT.notFound;
    case "FORBIDDEN": return EXIT.unauthorized;
    case "RATE_LIMITED": case "DEPTH_EXCEEDED": case "UNSUPPORTED": return EXIT.refused;
    default: return EXIT.error;
  }
}

/** The app's control plane: `HIVE_HCP_SOCK`, given every agent, else the app's own. */
export function sockPath(where: Where = {}): string {
  return appSocket("hcp.sock", "HIVE_HCP_SOCK", where);
}

/** Who this is to the app: `HCP_TOKEN`, an agent's own, else the install's, the person's. */
export function token(where: Where = {}): string {
  const { env = process.env } = where;
  const given = envGet(env, "HCP_TOKEN");
  if (given) return given;
  try {
    return fs.readFileSync(path.join(appData(where), "hcp.token"), "utf8").trim();
  } catch {
    return "";
  }
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
      c.write(JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { token: token() } }) + "\n"
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

export interface StreamEvent { seq: number; chunk: string; offset?: number; replay?: boolean }

/** Subscribe to a tile's live output. Resolves when the stream ends (server
 *  closed, `stop()` called, or `timeoutMs` elapsed). */
export function hcpStream(
  params: { tileId: string; since?: number; lines?: number },
  onEvent: (ev: StreamEvent) => void,
  opts: { timeoutMs?: number; signal?: { stop: () => void } } = {},
): Promise<{ offset: number }> {
  const sock = sockPath();
  if (!fs.existsSync(sock)) return Promise.reject(unavailable(`hivemind app not running (no socket at ${sock})`));
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    let subscriptionId: string | undefined;
    let lastOffset = params.since ?? 0;
    let done = false;
    const c = open({ id: reqId, method: "agent.stream/subscribe", params }, (m) => {
      if (m.id === reqId) {
        if (m.error) return finish(rpcError(m));
        const r = (m.result ?? {}) as { subscriptionId?: string; offset?: number };
        subscriptionId = r.subscriptionId;
        if (typeof r.offset === "number") lastOffset = r.offset;
        return;
      }
      if (m.method !== "agent.stream") return;
      const ev = (m.params ?? {}) as StreamEvent & { subscriptionId?: string };
      if (ev.subscriptionId !== subscriptionId) return;
      if (typeof ev.offset === "number") lastOffset = ev.offset;
      onEvent(ev);
    }, (e) => finish(e));
    const stop = () => {
      try { c.write(JSON.stringify({ jsonrpc: "2.0", id: "unsub", method: "agent.stream/unsubscribe", params: { subscriptionId } }) + "\n"); } catch { /* */ }
      finish();
    };
    if (opts.signal) opts.signal.stop = stop;
    const timer = opts.timeoutMs ? setTimeout(stop, opts.timeoutMs) : undefined;
    function finish(err?: Error) {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      try { c.end(); } catch { /* */ }
      if (err) reject(err); else resolve({ offset: lastOffset });
    }
    c.on("close", () => finish());
  });
}
