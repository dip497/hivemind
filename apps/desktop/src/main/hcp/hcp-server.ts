/**
 * HCP server — a 0600 unix socket owned by Electron main, speaking JSON-RPC 2.0 (protocol.ts).
 *
 * Transport only: it frames messages, checks the token, delegates every method to
 * `deps.dispatch` (hcp/methods.ts), and runs the two streams — a tile's live output
 * (`agent.stream/subscribe`) and every session's status (`status/subscribe`). A stream's
 * notifications carry the subscription id, not the request id: a stream outlives its request.
 * Each output chunk carries a monotonic `seq` so a client can detect drops.
 */
import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { HCP_VERSION, HcpError, RPC, takeLines, type RpcId } from "./protocol.js";

export interface HcpServerDeps {
  token: string;
  /** The socket could not be opened (e.g. a userData path too long for a unix socket),
   *  so the app can say so instead of looking like it is simply not running. */
  onListenError?: (err: Error) => void;
  rendererUp: () => boolean;
  dispatch: (method: string, params: unknown) => Promise<unknown>;
  /** A hook's `agent.event`, or anything a remote machine's daemon passes on. */
  onEvent: (method: string, params: unknown) => void;
  /** agent.stream catch-up: the recorder's ANSI-stripped text for a tile — the last
   *  `lines` lines, or everything appended after byte offset `since`. */
  replay?: (tileId: string, opts: { since?: number; lines?: number }) => string;
  /** The recorder's current byte offset for a tile — on every chunk, so a client can resume. */
  offsetOf?: (tileId: string) => number;
  /** Session statuses. */
  status?: StatusFeed;
}

/** What `status/subscribe` reads: a snapshot, the changes since a cursor, and live ones. */
export interface StatusFeed {
  all: () => Array<{ tileId: string; status: unknown }>;
  cursor: () => number;
  since: (seq: number) => Array<{ seq: number; tileId: string; status: unknown }> | null;
  subscribe: (fn: (c: { seq: number; tileId: string; status: unknown }) => void) => () => void;
}

export interface HcpServer {
  close: () => void;
  /** Fan a raw output chunk out to every live agent.stream subscriber of a tile. */
  broadcast: (tileId: string, chunk: string) => void;
  /** Handle a notification that arrived some other way (a remote machine's daemon). */
  injectEvent: (method: string, params: unknown) => void;
}

/** The one notification accepted before `initialize`: a hook reporting. */
const HOOK_NOTIFICATIONS = new Set(["agent.event"]);

interface Sub {
  id: string;
  tileId: string;
  notify: (method: string, params: unknown) => void;
  seq: number;
  /** Socket buffered-but-not-flushed → we're behind; drop+gap rather than OOM. */
  isBackedUp: () => boolean;
}

export function startHcpServer(sockPath: string, deps: HcpServerDeps): HcpServer {
  try { fs.unlinkSync(sockPath); } catch { /* none / not ours */ }

  // subscriptionId → Sub, shared across all connections (one tile can have many subs).
  const subs = new Map<string, Sub>();

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    let authed = false;
    const mySubs = new Set<string>();
    let statusOff: (() => void) | undefined;
    const write = (m: Record<string, unknown>) => { try { conn.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"); } catch { /* gone */ } };
    const notify = (method: string, params: unknown) => write({ method, params });

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
    conn.on("close", () => { for (const id of mySubs) subs.delete(id); statusOff?.(); });
    conn.on("error", () => { /* client gone; close handler sweeps subs */ });

    function handle(m: { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: unknown }): void {
      const id = m.id ?? null;
      const reply = (result: unknown) => { if (id !== null) write({ id, result: result ?? null }); };
      const fail = (code: number, message: string, hcp?: string) => {
        if (id !== null) write({ id, error: { code, message, ...(hcp ? { data: { code: hcp } } : {}) } });
      };
      if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(RPC.invalid, "not a JSON-RPC 2.0 message");
      const params = (m.params ?? {}) as Record<string, unknown>;

      if (id === null) {
        // A notification: a hook reporting. No reply, whatever happens.
        if (HOOK_NOTIFICATIONS.has(m.method) || authed) { try { deps.onEvent(m.method, m.params); } catch { /* ignore */ } }
        return;
      }
      if (m.method === "initialize") {
        if (params.token !== deps.token) return fail(RPC.hcp, "bad or missing token", "UNAUTHORIZED");
        authed = true;
        return reply({ protocolVersion: HCP_VERSION, rendererUp: deps.rendererUp(), capabilities: { status: !!deps.status } });
      }
      if (!authed) return fail(RPC.hcp, "call initialize with the token first", "UNAUTHORIZED");

      switch (m.method) {
        case "agent.stream/subscribe": {
          const tileId = String(params.tileId ?? "");
          if (!tileId) return fail(RPC.hcp, "tileId required", "BAD_REQUEST");
          const subscriptionId = randomUUID();
          subs.set(subscriptionId, { id: subscriptionId, tileId, notify, seq: 0, isBackedUp: () => conn.writableLength > 4 * 1024 * 1024 });
          mySubs.add(subscriptionId);
          const offset = deps.offsetOf?.(tileId) ?? 0;
          reply({ subscriptionId, offset });
          // Catch-up: what the recorder already holds (seq 0, replay) before live chunks.
          const since = typeof params.since === "number" ? params.since : undefined;
          const lines = typeof params.lines === "number" ? params.lines : undefined;
          if ((since !== undefined || lines !== undefined) && deps.replay) {
            const chunk = deps.replay(tileId, { since, lines });
            if (chunk) notify("agent.stream", { subscriptionId, seq: 0, chunk, offset, replay: true });
          }
          return;
        }
        case "agent.stream/unsubscribe": {
          const sid = String(params.subscriptionId ?? "");
          if (subs.delete(sid)) mySubs.delete(sid);
          return reply(null);
        }
        case "status/subscribe": {
          const feed = deps.status;
          if (!feed) return fail(RPC.method, "status is not available here", "UNKNOWN_METHOD");
          statusOff?.();
          const changes = typeof params.since === "number" ? feed.since(params.since) : null;
          // Past the log's reach (or no cursor): the whole picture, then changes from here on.
          reply(changes ? { cursor: feed.cursor(), changes } : { cursor: feed.cursor(), snapshot: feed.all() });
          statusOff = feed.subscribe((c) => notify("status/changed", c));
          return;
        }
        case "status/unsubscribe":
          statusOff?.();
          statusOff = undefined;
          return reply(null);
      }
      deps.dispatch(m.method, params).then(reply, (e) => {
        const err = e instanceof HcpError ? e : new HcpError("INTERNAL", (e as Error)?.message ?? String(e));
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
    broadcast: (tileId, chunk) => {
      for (const sub of subs.values()) {
        if (sub.tileId !== tileId) continue;
        sub.seq += 1;
        // Backpressure: a slow reader loses chunks (the seq gap says so) instead of growing memory.
        if (sub.isBackedUp()) continue;
        sub.notify("agent.stream", { subscriptionId: sub.id, seq: sub.seq, chunk, offset: deps.offsetOf?.(tileId) });
      }
    },
  };
}
