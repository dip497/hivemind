/**
 * HCP server — a 0600 unix socket (NDJSON) owned by Electron main. Drivers (the
 * hive MCP server, a CLI) issue token-authenticated `req`s; injected hooks fire
 * unauthenticated one-shot `event`s (the 0600 socket gates them to same-uid).
 * Drivers may also `sub`scribe to an agent's live output and receive `evt`
 * chunks until they `unsub` or disconnect (the agent.stream feature).
 *
 * Transport only: it frames messages, checks the token, delegates every method
 * to `deps.dispatch` (hcp/methods.ts), and fans out output chunks to
 * subscribers via the returned `broadcast`. Generalizes plan-bridge.ts.
 *
 * Streaming follows the LSP/CDP/MCP convention: one socket, multiplexed by a
 * subscription id carried in the event params (NOT the request id — a stream
 * outlives its request, and JSON-RPC forbids two responses to one id). Each
 * chunk carries a monotonic `seq` so a client can detect drops.
 */
import net from "node:net";
import fs from "node:fs";
import {
  HCP_VERSION,
  HcpError,
  takeLines,
  type HcpClientMsg,
  type HcpServerMsg,
} from "./protocol.js";

export interface HcpServerDeps {
  token: string;
  rendererUp: () => boolean;
  dispatch: (method: string, params: unknown) => Promise<unknown>;
  onEvent: (topic: string, data: unknown) => void;
}

export interface HcpServer {
  close: () => void;
  /** Fan a raw output chunk out to every live agent.stream subscriber of a tile. */
  broadcast: (tileId: string, chunk: string) => void;
}

interface Sub {
  id: string;
  tileId: string;
  send: (m: HcpServerMsg) => void;
  seq: number;
  /** Socket buffered-but-not-flushed → we're behind; drop+gap rather than OOM. */
  isBackedUp: () => boolean;
}

export function startHcpServer(sockPath: string, deps: HcpServerDeps): HcpServer {
  try { fs.unlinkSync(sockPath); } catch { /* none / not ours */ }

  // subId → Sub, shared across all connections (one tile can have many subs).
  const subs = new Map<string, Sub>();

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    const mySubIds = new Set<string>();
    const send = (m: HcpServerMsg) => { try { conn.write(JSON.stringify(m) + "\n"); } catch { /* gone */ } };

    send({ t: "hello", version: HCP_VERSION, rendererUp: deps.rendererUp() });

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
        let msg: HcpClientMsg;
        try {
          msg = JSON.parse(line) as HcpClientMsg;
        } catch {
          send({ t: "res", id: "?", ok: false, error: { code: "BAD_REQUEST", message: "invalid json" } });
          continue;
        }
        handle(msg);
      }
    });
    conn.on("close", () => { for (const id of mySubIds) subs.delete(id); });
    conn.on("error", () => { /* client gone; close handler sweeps subs */ });

    function handle(msg: HcpClientMsg): void {
      if (msg.t === "event") {
        try { deps.onEvent(msg.topic, msg.data); } catch { /* ignore */ }
        return;
      }
      if (msg.t === "unsub") {
        if (subs.delete(msg.id)) mySubIds.delete(msg.id);
        return;
      }
      if (msg.t === "sub") {
        if (msg.token !== deps.token) {
          send({ t: "res", id: msg.id, ok: false, error: { code: "UNAUTHORIZED", message: "bad or missing token" } });
          return;
        }
        if (msg.topic !== "agent.stream") {
          send({ t: "res", id: msg.id, ok: false, error: { code: "UNKNOWN_METHOD", message: `unknown sub topic: ${msg.topic}` } });
          return;
        }
        const tileId = String((msg.params as { tileId?: string })?.tileId ?? "");
        if (!tileId) {
          send({ t: "res", id: msg.id, ok: false, error: { code: "BAD_REQUEST", message: "tileId required" } });
          return;
        }
        subs.set(msg.id, { id: msg.id, tileId, send, seq: 0, isBackedUp: () => conn.writableLength > 4 * 1024 * 1024 });
        mySubIds.add(msg.id);
        send({ t: "res", id: msg.id, ok: true, result: { subscriptionId: msg.id } });
        return;
      }
      // req
      const { id, method, params, token } = msg;
      if (token !== deps.token) {
        send({ t: "res", id, ok: false, error: { code: "UNAUTHORIZED", message: "bad or missing token" } });
        return;
      }
      deps.dispatch(method, params).then(
        (result) => send({ t: "res", id, ok: true, result }),
        (e) => {
          const err = e instanceof HcpError ? e : new HcpError("INTERNAL", (e as Error)?.message ?? String(e));
          send({ t: "res", id, ok: false, error: { code: err.code, message: err.message } });
        },
      );
    }
  });

  server.on("error", (err) => console.error("[hcp] listen error:", err));
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
  });

  return {
    close: () => {
      try { server.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    },
    broadcast: (tileId, chunk) => {
      for (const sub of subs.values()) {
        if (sub.tileId !== tileId) continue;
        sub.seq += 1;
        // Backpressure: if the client's socket buffer is deep, skip the chunk
        // (the seq gap tells the client bytes were dropped) instead of growing
        // memory unbounded for a slow reader.
        if (sub.isBackedUp()) continue;
        sub.send({ t: "evt", subId: sub.id, topic: "agent.stream", data: { seq: sub.seq, chunk } });
      }
    },
  };
}
