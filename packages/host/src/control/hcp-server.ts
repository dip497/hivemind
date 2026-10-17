/**
 * HCP server — a 0600 unix socket owned by Electron main, speaking JSON-RPC 2.0 (protocol.ts).
 *
 * Transport only: it frames messages, checks the token, and delegates every method to
 * `deps.dispatch` (hcp/methods.ts).
 */
import net from "node:net";
import fs from "node:fs";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { HCP_VERSION, RPC, takeLines, type HcpCall, type RpcId } from "./protocol.js";
import type { Actor } from "@hivemind/workspace-host/intents";

export interface HcpServerDeps {
  /** Who holds a token: the person, a tile, or null for one this app does not know. */
  authenticate: (token: unknown) => Actor | null;
  /** The socket could not be opened (e.g. a userData path too long for a unix socket),
   *  so the app can say so instead of looking like it is simply not running. */
  onListenError?: (err: Error) => void;
  rendererUp: () => boolean;
  dispatch: (method: string, params: unknown, call: HcpCall) => Promise<unknown>;
  /** A hook's `agent.event`, from `from`, whoever's token the connection gave; or anything a
   *  remote machine's daemon passes on, with no `from`. */
  onEvent: (method: string, params: unknown, from?: Actor) => void;
}

export interface HcpServer {
  close: () => void;
  /** Handle a notification that arrived some other way (a remote machine's daemon). */
  injectEvent: (method: string, params: unknown) => void;
}


export function startHcpServer(sockPath: string, deps: HcpServerDeps): HcpServer {
  try { fs.unlinkSync(sockPath); } catch { /* none / not ours */ }

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    let actor: Actor | null = null;
    // A request still running when its caller goes (a hook that gave up waiting) is told so.
    const gone = new AbortController();
    const write = (m: Record<string, unknown>) => { try { conn.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"); } catch { /* gone */ } };

    conn.on("data", (chunk: string) => {
      buf += chunk;
      let lines: string[];
      try {
        ({ lines, rest: buf } = takeLines(buf));
      } catch {
        try { conn.destroy(); } catch { /* ignore */ }
        return;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: unknown };
        try { msg = JSON.parse(line); } catch { write({ id: null, error: { code: RPC.parse, message: "invalid json" } }); continue; }
        handle(msg);
      }
    });
    conn.on("close", () => gone.abort());
    conn.on("error", () => { /* client gone */ });

    function handle(m: { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: unknown }): void {
      const id = m.id ?? null;
      const reply = (result: unknown) => { if (id !== null) write({ id, result: result ?? null }); };
      const fail = (code: number, message: string, hcp?: string) => {
        if (id !== null) write({ id, error: { code, message, ...(hcp ? { data: { code: hcp } } : {}) } });
      };
      if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(RPC.invalid, "not a JSON-RPC 2.0 message");
      const params = (m.params ?? {}) as Record<string, unknown>;

      if (id === null) {
        // A notification: a hook reporting, heard only once it signed in. No reply, whatever happens.
        if (actor) { try { deps.onEvent(m.method, m.params, actor); } catch { /* ignore */ } }
        return;
      }
      if (m.method === "initialize") {
        actor = deps.authenticate(params.token);
        if (!actor) return fail(RPC.hcp, "bad or missing token", "FORBIDDEN");
        return reply({ protocolVersion: HCP_VERSION, rendererUp: deps.rendererUp(), });
      }
      if (!actor) return fail(RPC.hcp, "call initialize with the token first", "FORBIDDEN");

      deps.dispatch(m.method, params, { actor, signal: gone.signal }).then(reply, (e) => {
        const err = e instanceof ApiError ? e : new ApiError("FAILED", (e as Error)?.message ?? String(e));
        fail(err.code === "UNKNOWN_METHOD" ? RPC.method : RPC.hcp, err.message, err.code);
      });
    }
  });

  // A control plane that never came up is invisible otherwise: `hive ctl` just reports
  // "app not running". The usual cause is a userData path too long for a unix socket.
  server.on("error", (err) => {
    console.error("[hcp] listen error:", err);
    deps.onListenError?.(err as Error);
  });
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
  });

  return {
    close: () => {
      try { server.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    },
    injectEvent: (method, params) => {
      try { deps.onEvent(method, params); } catch { /* ignore */ }
    },
  };
}
