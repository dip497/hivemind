/** Client for the PTY daemon socket; the protocol is imported from the desktop, never copied. */
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg, type SessionInfo } from "../../desktop/src/main/pty-protocol.js";
import { configDir } from "./hcp.js";

export type { SessionInfo };

/** The desktop's daemon path on Linux, so the app and the CLI share one daemon per machine. */
export function defaultSocket(): string {
  return process.env.HIVEMIND_PTY_SOCK || path.join(configDir(), "hivemind", "pty-daemon.sock");
}

/** sun_path limit; a longer path fails later with a misleading EADDRINUSE. */
export const MAX_SOCKET_PATH = 100;

export class DaemonUnavailable extends Error {
  constructor(public socket: string, cause?: string) {
    super(`no PTY daemon on ${socket}${cause ? ` (${cause})` : ""} — start one with \`hive daemon start\``);
  }
}

export interface DaemonConn {
  send(m: ClientMsg): void;
  next<T extends ServerMsg>(pick: (m: ServerMsg) => m is T, timeoutMs?: number): Promise<T>;
  onMessage(cb: (m: ServerMsg) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export function connect(socket: string, timeoutMs = 2000): Promise<DaemonConn> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socket);
    const listeners: ((m: ServerMsg) => void)[] = [];
    const closers: (() => void)[] = [];
    let closed = false;
    const timer = setTimeout(() => { s.destroy(); reject(new DaemonUnavailable(socket, "timed out")); }, timeoutMs);
    s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new DaemonUnavailable(socket, e.code)); });
    s.on("data", makeLineDecoder((line) => {
      let m: ServerMsg;
      try { m = JSON.parse(line) as ServerMsg; } catch { return; }
      for (const l of [...listeners]) l(m);
    }));
    s.on("close", () => { closed = true; for (const c of closers) c(); });
    s.once("connect", () => {
      clearTimeout(timer);
      s.on("error", () => { /* surfaced through close */ });
      resolve({
        send: (m) => { if (!closed) s.write(frame(m)); },
        next: (pick, ms = 5000) => new Promise((res, rej) => {
          const t = setTimeout(() => { off(); rej(new Error("daemon did not answer in time")); }, ms);
          const onMsg = (m: ServerMsg) => { if (pick(m)) { off(); res(m); } };
          const onGone = () => { off(); rej(new DaemonUnavailable(socket, "connection closed")); };
          const off = () => { clearTimeout(t); listeners.splice(listeners.indexOf(onMsg), 1); const i = closers.indexOf(onGone); if (i >= 0) closers.splice(i, 1); };
          listeners.push(onMsg);
          closers.push(onGone);
        }),
        onMessage: (cb) => { listeners.push(cb); },
        onClose: (cb) => { if (closed) cb(); else closers.push(cb); },
        close: () => { s.end(); s.destroy(); },
      });
    });
  });
}

/** `null` when nothing answers; never throws. */
export async function ping(socket: string, timeoutMs = 1000): Promise<{ buildStamp?: number } | null> {
  try {
    const c = await connect(socket, timeoutMs);
    try {
      c.send({ t: "ping", reqId: "ping" });
      const pong = await c.next((m): m is Extract<ServerMsg, { t: "pong" }> => m.t === "pong", timeoutMs);
      return { buildStamp: pong.buildStamp };
    } finally { c.close(); }
  } catch { return null; }
}

export async function listSessions(socket: string): Promise<SessionInfo[]> {
  const c = await connect(socket);
  try {
    c.send({ t: "list", reqId: "ls", detail: true });
    const r = await c.next((m): m is Extract<ServerMsg, { t: "sessions" }> => m.t === "sessions");
    // Older daemons answer with ids only.
    return r.detail ?? r.ids.map((id) => ({ id, state: "live" as const, cmd: "?", args: [], cwd: "?", pid: null, viewers: 0, cols: 0, rows: 0 }));
  } finally { c.close(); }
}

/** Exact id, else a unique prefix. */
export function resolveSession(list: SessionInfo[], ref: string): SessionInfo {
  const exact = list.find((s) => s.id === ref);
  if (exact) return exact;
  const hits = list.filter((s) => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new SessionRefError("session_ambiguous", `'${ref}' matches ${hits.map((s) => s.id).join(", ")}`);
  throw new SessionRefError("session_not_found", `no session '${ref}' — see \`hive ps\``);
}

export class SessionRefError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
