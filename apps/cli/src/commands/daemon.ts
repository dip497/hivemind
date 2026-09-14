/** `hive daemon start|status|stop` — the desktop's PTY daemon, hosted by `hive` on machines without the app. */
import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { connect, defaultSocket, listSessions, MAX_SOCKET_PATH, ping } from "../pty-client.js";
import { compiledSelf } from "../remote.js";
import { BRIDGE_READY } from "../../../desktop/src/main/pty-protocol.js";

/** Set by scripts/build.ts so bun embeds the addon; absent when running from source. */
declare const HIVE_PTY_NATIVE: string | undefined;

const socketArg = { socket: { type: "string", description: "daemon socket (default: $HIVEMIND_PTY_SOCK or <config>/hivemind/pty-daemon.sock)" } } as const;

/** argv that re-runs this same `hive`. */
export function selfArgv(): string[] {
  return compiledSelf() ? [process.execPath] : [process.execPath, process.argv[1]!];
}

export function checkSocketPath(sock: string): string | null {
  if (!path.isAbsolute(sock)) return `socket path must be absolute (got '${sock}')`;
  if (Buffer.byteLength(sock) > MAX_SOCKET_PATH) return `socket path is ${Buffer.byteLength(sock)} bytes; unix sockets allow ~${MAX_SOCKET_PATH} — pick a shorter --socket`;
  return null;
}

/** Start the daemon if nothing answers on `sock`, and wait until it does. */
export async function ensureDaemon(sock: string): Promise<{ started: boolean }> {
  if (await ping(sock)) return { started: false };
  const dir = path.dirname(sock);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(dir, "pty-daemon.log"), "a");
  const [file, ...args] = [...selfArgv(), "daemon", "start", "--foreground", "--socket", sock];
  // Detached so it outlives this command and the ssh session that ran it.
  const child = spawn(file!, args, { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.closeSync(log);
  for (let t = 0; t < 10_000; t += 100) {
    if (await ping(sock, 500)) return { started: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not come up on ${sock} — see ${path.join(dir, "pty-daemon.log")}`);
}

/** Why this `hive` cannot host a daemon here, or null. */
export function daemonUnsupported(): string | null {
  if (process.platform === "win32") return "hive daemon is not available on Windows yet — use the desktop app";
  if (!compiledSelf()) return null; // from source: bun-pty resolves the addon from node_modules
  if (typeof HIVE_PTY_NATIVE !== "string") return "this hive was built without the PTY addon — use a release build";
  // node-pty needs its `spawn-helper` on disk there; extracting it is not implemented.
  if (process.platform === "darwin") return "the compiled hive cannot host a daemon on macOS yet — run the desktop app there";
  return null;
}

async function runForeground(sock: string): Promise<never> {
  if (typeof HIVE_PTY_NATIVE === "string") {
    (globalThis as { __hivePtyNative?: unknown }).__hivePtyNative = { native: require(HIVE_PTY_NATIVE), dir: path.dirname(process.execPath) };
  }
  // The daemon reads its socket from argv[2] and runs on import.
  process.argv = [process.argv[0]!, process.argv[1]!, sock];
  process.env.HIVEMIND_DAEMON_STANDALONE = "1";
  await import("../../../desktop/src/main/pty-daemon.js");
  return new Promise<never>(() => { /* the daemon owns the process now */ });
}

const startCmd = defineCommand({
  meta: { name: "start", description: "Start this machine's PTY daemon (no-op if one is already running)" },
  args: { ...socketArg, foreground: { type: "boolean", description: "run in this process instead of detaching" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const sock = String(args.socket || defaultSocket());
    const bad = checkSocketPath(sock);
    if (bad) return err(ctx, "socket_invalid", bad, EXIT.usage);
    const unsupported = daemonUnsupported();
    if (unsupported) return err(ctx, "daemon_unsupported", unsupported, EXIT.unavailable);
    if (args.foreground) {
      if (await ping(sock)) return ok(ctx, { socket: sock, running: true, started: false }, () => `already running on ${sock}`);
      try { return await runForeground(sock); } catch (e) { return err(ctx, "daemon_start_failed", (e as Error).message); }
    }
    try {
      const r = await ensureDaemon(sock);
      return ok(ctx, { socket: sock, running: true, started: r.started }, () => (r.started ? `started on ${sock}` : `already running on ${sock}`));
    } catch (e) { return err(ctx, "daemon_start_failed", (e as Error).message); }
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Is a daemon running here, and how many sessions does it hold" },
  args: { ...socketArg, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const sock = String(args.socket || defaultSocket());
    const pong = await ping(sock);
    if (!pong) return ok(ctx, { socket: sock, running: false }, () => `not running (${sock})`);
    const sessions = await listSessions(sock).catch(() => []);
    const live = sessions.filter((s) => s.state === "live").length;
    return ok(ctx, { socket: sock, running: true, buildStamp: pong.buildStamp ?? null, sessions: sessions.length, live },
      () => `running on ${sock} · ${sessions.length} session(s), ${live} live`);
  },
});

const stopCmd = defineCommand({
  meta: { name: "stop", description: "Stop the daemon; sessions persist as snapshots and restore on next start" },
  args: { ...socketArg, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const sock = String(args.socket || defaultSocket());
    if (!(await ping(sock))) return ok(ctx, { socket: sock, stopped: false }, () => `not running (${sock})`);
    try {
      const c = await connect(sock);
      c.send({ t: "shutdown" });
      c.close();
    } catch { /* raced with its own exit */ }
    for (let t = 0; t < 10_000; t += 100) {
      if (!(await ping(sock, 300))) return ok(ctx, { socket: sock, stopped: true }, () => `stopped (${sock})`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return err(ctx, "daemon_stop_timeout", `daemon on ${sock} is still answering after 10s`, EXIT.timeout);
  },
});

const bridgeCmd = defineCommand({
  meta: { name: "bridge", description: "Connect stdin/stdout to this machine's daemon (the desktop runs this over ssh)" },
  args: { ...socketArg },
  async run({ args }) {
    const ctx = { json: false };
    const sock = String(args.socket || defaultSocket());
    const bad = checkSocketPath(sock) ?? daemonUnsupported();
    if (bad) return err(ctx, "daemon_unsupported", bad, EXIT.unavailable);
    try { await ensureDaemon(sock); } catch (e) { return err(ctx, "daemon_start_failed", (e as Error).message, EXIT.unavailable); }
    const s = net.connect(sock);
    s.once("error", (e) => err(ctx, "daemon_unavailable", e.message, EXIT.unavailable));
    s.once("connect", () => {
      // The leading newline ends any line a shell profile left unterminated.
      process.stdout.write(`\n${BRIDGE_READY}`);
      process.stdin.pipe(s);
      s.pipe(process.stdout);
    });
    s.on("close", () => process.exit(0));
    process.stdin.on("end", () => s.end());
    return new Promise<never>(() => { /* runs until either side closes */ });
  },
});

export const daemonCmd = defineCommand({
  meta: { name: "daemon", description: "This machine's PTY daemon (persistent terminal sessions)" },
  subCommands: { start: startCmd, status: statusCmd, stop: stopCmd, bridge: bridgeCmd },
});
