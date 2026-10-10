/**
 * The drive socket from the command line (spec/workspace-api.md "Drive socket"): the workspace
 * API of the running app or `hive host`, as whoever the token is — the agent whose tile this runs
 * in (`HCP_TOKEN`), or the person at this machine — its calls answered and its events heard on
 * one connection.
 */
import fs from "node:fs";
import net from "node:net";
import { appSocket, envGet, type Where } from "./app-data.js";
import { EXIT, HcpCliError, exitCodeFor, token } from "./hcp.js";

/** Where programs drive this machine: `HIVE_DRIVE_SOCK`, given every agent, else the app's own. */
export function driveSockPath(where: Where = {}): string {
  return appSocket("drive.sock", "HIVE_DRIVE_SOCK", where);
}

/** Who the host says this connection is: the person, an agent, or a program a grant lets in,
 *  each of the latter two driving one workspace, named by its folder. */
export type DriveAs = "person" | { agent: string; role: string; workspace: string } | { client: string; role: string; workspace: string };

export interface Drive {
  as: DriveAs;
  /** Call `method`; `timeoutMs` bounds this call alone. */
  call(method: string, params: unknown[], timeoutMs?: number): Promise<unknown>;
  /** Tell the host `method`, which it does not answer. */
  notice(method: string, params: unknown[]): void;
  /** Hear `event`, until the returned function is called. */
  on(event: string, listener: (...params: unknown[]) => void): () => void;
  /** Resolves when the host closes the connection. */
  closed: Promise<void>;
  close(): void;
}

const unavailable = (message: string) => new HcpCliError("UNAVAILABLE", message, EXIT.unavailable);
const refused = (e: { code?: string; message?: string } | undefined) => {
  const code = e?.code ?? "FAILED";
  return new HcpCliError(code, e?.message ?? code, exitCodeFor(code));
};

/** Say hello on the drive socket: the connection, once the host says who this is. */
export function openDrive(where: Where = {}): Promise<Drive> {
  const sock = driveSockPath(where);
  if (process.platform !== "win32" && !fs.existsSync(sock)) {
    return Promise.reject(unavailable(`neither the hivemind app nor \`hive host\` is running (no socket at ${sock})`));
  }
  return new Promise((resolve, reject) => {
    let next = 1;
    const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    const listeners = new Map<string, Set<(...params: unknown[]) => void>>();
    let closedResolve!: () => void;
    const closed = new Promise<void>((r) => (closedResolve = r));
    let as: DriveAs | undefined;
    // A grant reaching several workspaces drives the one `HIVE_WORKSPACE` names.
    const workspace = envGet(where.env ?? process.env, "HIVE_WORKSPACE");
    const c = net.connect(sock, () => c.write(`${JSON.stringify({ hello: { token: token(where), ...(workspace ? { workspace } : {}) } })}\n`));
    c.setEncoding("utf8");
    const hear = (m: { event?: unknown; params?: unknown }) => {
      if (typeof m.event !== "string") return;
      for (const l of listeners.get(m.event) ?? []) l(...(Array.isArray(m.params) ? m.params : []));
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
        // The events of one moment come as a list.
        if (Array.isArray(m)) { for (const e of m) hear(e as { event?: unknown }); continue; }
        const msg = m as { hello?: { as?: DriveAs }; id?: unknown; result?: unknown; error?: { code?: string; message?: string }; event?: unknown };
        if (!as) {
          if (msg.hello?.as) {
            as = msg.hello.as;
            resolve({ as, call, notice: (method, params) => { c.write(`${JSON.stringify({ method, params })}\n`); }, on, closed, close: () => c.destroy() });
          } else {
            reject(refused(msg.error));
            c.destroy();
          }
          continue;
        }
        if (typeof msg.id === "number") {
          const w = waiting.get(msg.id);
          waiting.delete(msg.id);
          if (msg.error) w?.reject(refused(msg.error));
          else w?.resolve(msg.result);
          continue;
        }
        hear(msg);
      }
    });
    c.on("error", (e) => {
      if (!as) reject(unavailable(`the drive socket is not answering: ${e.message}`));
    });
    c.on("close", () => {
      if (!as) reject(unavailable("the drive socket closed before it said who this is"));
      for (const w of waiting.values()) w.reject(unavailable("the drive socket closed before it answered"));
      waiting.clear();
      closedResolve();
    });

    function call(method: string, params: unknown[], timeoutMs = 30_000): Promise<unknown> {
      const id = next++;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { waiting.delete(id); rej(new HcpCliError("TIMEOUT", `no answer to ${method} within ${timeoutMs} ms`, EXIT.timeout)); }, timeoutMs);
        waiting.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
        c.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    }
    function on(event: string, listener: (...params: unknown[]) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => { set!.delete(listener); };
    }
  });
}

/** One call on its own connection. */
export async function driveCall(method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
  const drive = await openDrive();
  try {
    return await drive.call(method, params, timeoutMs);
  } finally {
    drive.close();
  }
}
