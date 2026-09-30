/**
 * The running `hive host` and the commands that ask it things (`hive host status`, `hive host
 * stop`): one line of JSON each way, on a socket in its data folder that only its user can open,
 * like the daemon's. Holding the socket is what makes a host the one running here.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { listenExclusive } from "@hivemind/agent-host/socket-claim";
import { makeLineDecoder } from "@hivemind/agent-host/pty-protocol";

/** The control socket for the host serving `dir`: in it, unless the path is too long. */
export function controlSocket(dir: string): string {
  const inData = path.join(dir, "host.sock");
  if (inData.length < 100) return inData;
  return path.join(os.tmpdir(), `hivemind-host-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.sock`);
}

export type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;

/** Answer on `sock`, unless a host already does ("taken"). */
export async function serveControl(sock: string, handlers: Handlers): Promise<{ server: net.Server; claim: "listening" | "taken" }> {
  const server = net.createServer((c) => {
    c.on("error", () => { /* the asker went */ });
    c.on("data", makeLineDecoder((line) => {
      let m: { cmd?: unknown; args?: unknown };
      try { m = JSON.parse(line); } catch { return; }
      const handler = typeof m.cmd === "string" ? handlers[m.cmd] : undefined;
      const reply = (body: Record<string, unknown>) => { try { c.end(`${JSON.stringify(body)}\n`); } catch { /* gone */ } };
      if (!handler) return reply({ ok: false, error: `hive host does not know ${String(m.cmd)}` });
      void Promise.resolve()
        .then(() => handler((m.args ?? {}) as Record<string, unknown>))
        .then((result) => reply({ ok: true, result }), (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }));
  });
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const claim = await listenExclusive(server, sock);
  if (claim === "listening") fs.chmodSync(sock, 0o600);
  return { server, claim };
}

export class HostNotRunning extends Error {
  constructor(sock: string) {
    super(`hive host is not running here (nothing answers on ${sock}): start it with \`hive host run\`, or \`hive host install\` to have it start with this machine`);
  }
}

/** Ask the host on `sock`; throws HostNotRunning when none answers. */
export function askHost(sock: string, cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`hive host did not answer ${cmd} within ${timeoutMs / 1000}s`)); }, timeoutMs);
    s.once("error", () => { clearTimeout(timer); reject(new HostNotRunning(sock)); });
    s.once("connect", () => s.write(`${JSON.stringify({ cmd, args })}\n`));
    s.on("data", makeLineDecoder((line) => {
      clearTimeout(timer);
      s.destroy();
      try {
        const r = JSON.parse(line) as { ok?: boolean; result?: unknown; error?: string };
        if (r.ok) resolve(r.result); else reject(new Error(r.error ?? "hive host refused"));
      } catch (e) {
        reject(e);
      }
    }));
  });
}

/** The pid of the app running on `dir`'s data, from Electron's single-instance lock; null when none. */
export function appRunning(dir: string): number | null {
  let target: string;
  try { target = fs.readlinkSync(path.join(dir, "SingletonLock")); } catch { return null; }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m || m[1] !== os.hostname()) return null;
  const pid = Number(m[2]);
  try { process.kill(pid, 0); return pid; } catch { return null; }
}
