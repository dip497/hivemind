/**
 * HCP client for `hive ctl` — one short-lived NDJSON connection per request
 * to the running desktop app's control-plane socket, plus a subscription helper
 * for `agent.stream`.
 *
 * Socket + token come from env (HIVE_HCP_SOCK / HCP_TOKEN — injected into every
 * agent hivemind spawns) else the well-known userData path
 * (<config>/hivemind/hcp.{sock,token}).
 *
 * Errors are structured: `HcpCliError { code, message, exit }` so every ctl
 * subcommand prints `{ ok:false, code, message }` and exits with a meaningful
 * status an agent can branch on (see EXIT).
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Exit codes — stable, documented in the hivemind skill. */
export const EXIT = {
  ok: 0,
  /** Unexpected failure / server INTERNAL. */
  error: 1,
  /** Bad arguments (client-side) or BAD_REQUEST / UNKNOWN_METHOD from the server. */
  usage: 2,
  /** The desktop app is not running / socket unreachable / renderer not up. */
  unavailable: 3,
  /** The wait (read / open-review / workflow) ran out of time. */
  timeout: 4,
  /** TILE_NOT_FOUND (or an issue/workspace that does not exist). */
  notFound: 5,
  /** UNAUTHORIZED — bad/missing HCP token. */
  unauthorized: 6,
  /** RATE_LIMITED / DEPTH_EXCEEDED — the control plane refused for now. */
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
    case "APP_NO_RENDERER": case "UNAVAILABLE": return EXIT.unavailable;
    case "TIMEOUT": return EXIT.timeout;
    case "TILE_NOT_FOUND": case "NOT_FOUND": return EXIT.notFound;
    case "UNAUTHORIZED": return EXIT.unauthorized;
    case "RATE_LIMITED": case "DEPTH_EXCEEDED": return EXIT.refused;
    default: return EXIT.error;
  }
}

export function configDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}
export function sockPath(): string {
  return process.env.HIVE_HCP_SOCK || path.join(configDir(), "hivemind", "hcp.sock");
}
export function token(): string {
  if (process.env.HCP_TOKEN) return process.env.HCP_TOKEN;
  try {
    return fs.readFileSync(path.join(configDir(), "hivemind", "hcp.token"), "utf8").trim();
  } catch {
    return "";
  }
}
/** This process's own tile id when it runs inside a hivemind-spawned agent. */
export function ownTile(): string | undefined {
  return process.env.HIVEMIND_TILE || undefined;
}

type ServerMsg = {
  t?: string; id?: string; subId?: string; ok?: boolean; result?: unknown;
  error?: { code?: string; message?: string }; data?: unknown; topic?: string;
};

function unavailable(msg: string): HcpCliError {
  return new HcpCliError("UNAVAILABLE", msg, EXIT.unavailable);
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
    let buf = "";
    let settled = false;
    const c = net.connect(sock, () => {
      try { c.write(JSON.stringify({ t: "req", id, method, params, token: token() }) + "\n"); } catch (e) { fail(unavailable((e as Error).message)); }
    });
    c.setEncoding("utf8");
    const timer = setTimeout(() => fail(new HcpCliError("TIMEOUT", `HCP request timed out after ${timeoutMs} ms`, EXIT.timeout)), timeoutMs);
    function ok(v: unknown) { if (settled) return; settled = true; clearTimeout(timer); try { c.end(); } catch { /* */ } resolve(v); }
    function fail(e: Error) { if (settled) return; settled = true; clearTimeout(timer); try { c.destroy(); } catch { /* */ } reject(e); }
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: ServerMsg;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === "hello") continue;
        if (m.t === "res" && m.id === id) {
          if (m.ok) return ok(m.result);
          const code = m.error?.code || "INTERNAL";
          return fail(new HcpCliError(code, m.error?.message || code, exitCodeFor(code)));
        }
      }
    });
    c.on("error", (e: Error) => fail(unavailable(`hivemind app not reachable: ${e.message}`)));
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
    const subId = randomUUID();
    let buf = "";
    let lastOffset = params.since ?? 0;
    let done = false;
    const c = net.connect(sock, () => {
      try { c.write(JSON.stringify({ t: "sub", id: subId, topic: "agent.stream", params, token: token() }) + "\n"); } catch (e) { finish(unavailable((e as Error).message)); }
    });
    c.setEncoding("utf8");
    const stop = () => { try { c.write(JSON.stringify({ t: "unsub", id: subId }) + "\n"); } catch { /* */ } finish(); };
    if (opts.signal) opts.signal.stop = stop;
    const timer = opts.timeoutMs ? setTimeout(stop, opts.timeoutMs) : undefined;
    function finish(err?: Error) {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      try { c.end(); } catch { /* */ }
      if (err) reject(err); else resolve({ offset: lastOffset });
    }
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: ServerMsg;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === "res" && m.id === subId) {
          if (m.ok === false) { const code = m.error?.code || "INTERNAL"; return finish(new HcpCliError(code, m.error?.message || code, exitCodeFor(code))); }
          const off = (m.result as { offset?: number } | undefined)?.offset;
          if (typeof off === "number") lastOffset = off;
          continue;
        }
        if (m.t === "evt" && m.subId === subId) {
          const ev = (m.data ?? {}) as StreamEvent;
          if (typeof ev.offset === "number") lastOffset = ev.offset;
          onEvent(ev);
        }
      }
    });
    c.on("error", (e: Error) => finish(unavailable(`hivemind app not reachable: ${e.message}`)));
    c.on("close", () => finish());
  });
}
