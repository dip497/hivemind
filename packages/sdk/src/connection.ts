/**
 * One connection to the drive socket (spec/workspace-api.md "Drive socket"): it says hello with a
 * token, then carries calls answered by their id, notices, and the events the host sends, singly
 * or several to a line. Node and Bun; a named pipe on Windows.
 */
import fs from "node:fs";
import net from "node:net";
import { ApiError, type ErrorCode } from "@hivemind/workspace-api/protocol";

/** Who the host says this connection is: the person at this machine, an agent in a tile, or a
 *  program a grant lets in; the last two drive one workspace, named by its folder. */
export type Identity =
  | "person"
  | { agent: string; role: string; workspace: string }
  | { client: string; role: string; workspace: string };

export interface CallOptions {
  /** How long to wait for the answer (default 30 s); `TIMEOUT` after it. */
  timeoutMs?: number;
}

export interface Connection {
  as: Identity;
  /** The workspace API version the host speaks. */
  api: string;
  call(method: string, params: unknown[], options?: CallOptions): Promise<unknown>;
  notice(method: string, params: unknown[]): void;
  on(event: string, listener: (...params: unknown[]) => void): () => void;
  closed: Promise<void>;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** An error as the host sent it; a code this SDK does not know yet is kept as sent. */
const fromHost = (e: { code?: unknown; message?: unknown } | undefined): ApiError => {
  const code = typeof e?.code === "string" ? e.code : "FAILED";
  return new ApiError(code as ErrorCode, typeof e?.message === "string" ? e.message : code);
};
const unavailable = (message: string) => new ApiError("UNAVAILABLE", message);

/** Open `socket`, say hello, and resolve once the host says who this is. */
export function openConnection(socket: string, hello: { token: string; workspace?: string }): Promise<Connection> {
  if (process.platform !== "win32" && !fs.existsSync(socket)) {
    return Promise.reject(unavailable(`neither the hivemind app nor \`hive host\` is running (no socket at ${socket})`));
  }
  return new Promise((resolve, reject) => {
    let next = 1;
    const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    const listeners = new Map<string, Set<(...params: unknown[]) => void>>();
    let closedResolve!: () => void;
    const closed = new Promise<void>((r) => (closedResolve = r));
    let welcomed = false;
    let ended = false;

    const c = net.connect(socket, () => {
      c.write(`${JSON.stringify({ hello: hello.workspace ? { token: hello.token, workspace: hello.workspace } : { token: hello.token } })}\n`);
    });
    c.setEncoding("utf8");

    const hear = (m: unknown): void => {
      const e = m as { event?: unknown; params?: unknown };
      if (typeof e?.event !== "string") return;
      const params = Array.isArray(e.params) ? e.params : [];
      for (const listener of listeners.get(e.event) ?? []) {
        // One listener's failure stops neither the others nor the connection.
        try { listener(...params); } catch (err) { console.error(`[hivemind-api] a listener for ${e.event} failed:`, err); }
      }
    };

    const take = (m: unknown): void => {
      // The events of one moment may come as a list on one line.
      if (Array.isArray(m)) { for (const e of m) hear(e); return; }
      const msg = m as { hello?: { api?: unknown; as?: Identity }; id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      if (!welcomed) {
        if (msg.hello?.as) {
          welcomed = true;
          resolve({ as: msg.hello.as, api: String(msg.hello.api ?? ""), call, notice, on, closed, close: () => c.destroy() });
        } else {
          reject(fromHost(msg.error));
          c.destroy();
        }
        return;
      }
      if (typeof msg.id === "number") {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) w?.reject(fromHost(msg.error));
        else w?.resolve(msg.result ?? null);
        return;
      }
      hear(msg);
    };

    let buf = "";
    c.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: unknown;
        try { m = JSON.parse(line); } catch { continue; }
        take(m);
      }
    });
    c.on("error", (e) => {
      if (!welcomed) reject(unavailable(`the drive socket is not answering: ${e.message}`));
    });
    c.on("close", () => {
      ended = true;
      if (!welcomed) reject(unavailable("the drive socket closed before it said who this is"));
      for (const w of waiting.values()) w.reject(unavailable("the connection closed before the answer came"));
      waiting.clear();
      closedResolve();
    });

    function call(method: string, params: unknown[], options: CallOptions = {}): Promise<unknown> {
      if (ended) return Promise.reject(unavailable("the connection is closed"));
      const id = next++;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { waiting.delete(id); rej(new ApiError("TIMEOUT", `no answer to ${method} within ${timeoutMs} ms`)); }, timeoutMs);
        waiting.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
        c.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    }
    function notice(method: string, params: unknown[]): void {
      if (!ended) c.write(`${JSON.stringify({ method, params })}\n`);
    }
    function on(event: string, listener: (...params: unknown[]) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => { set!.delete(listener); };
    }
  });
}
