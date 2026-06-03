/**
 * Daemon client — the main process's connection to the persistent PTY daemon.
 * Exposes the SAME surface as pty-host (spawnPty/writePty/resizePty/killPty +
 * detachPty) so index.ts can route to either. Spawns the daemon on demand and
 * reconnects transparently. See research/persistence-plan.md.
 */
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { type ClientMsg, type ServerMsg, SOCKET_NAME, frame, makeLineDecoder } from "./pty-protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SpawnOpts {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}
interface Callbacks {
  onData: (data: string) => void;
  onExit: (code: number, signal: number | undefined) => void;
}

let conn: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
const cbs = new Map<string, Callbacks>();
const pendingAttach = new Map<string, (r: { pid: number }) => void>();
// The attach spec per LIVE tile, kept so we can RE-attach after a socket drop
// (the daemon's createOrAttach is idempotent — it replays the existing session).
type AttachSpec = Extract<ClientMsg, { t: "attach" }>["spec"];
const specs = new Map<string, AttachSpec>();
let reqSeq = 0;
let reattaching = false;

const socketPath = () => path.join(app.getPath("userData"), SOCKET_NAME);
const daemonScript = () => path.join(__dirname, "pty-daemon.js");
const delay = (ms: number) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

function handleServerMsg(msg: ServerMsg): void {
  switch (msg.t) {
    case "attached": {
      if (msg.replay) cbs.get(msg.id)?.onData(msg.replay);
      const resolve = pendingAttach.get(msg.reqId);
      if (resolve) {
        pendingAttach.delete(msg.reqId);
        resolve({ pid: msg.pid });
      }
      break;
    }
    case "data":
      cbs.get(msg.id)?.onData(msg.data);
      break;
    case "exit":
      cbs.get(msg.id)?.onExit(msg.code, msg.signal ?? undefined);
      break;
    default:
      break;
  }
}

function setupConn(s: net.Socket): void {
  conn = s;
  // Don't let the client socket keep the Electron main's event loop alive —
  // otherwise the app never exits on close (the window goes away but main hangs
  // waiting on the open socket), which stalls quit/teardown. unref keeps the
  // connection fully functional while the app is running.
  s.unref();
  const decode = makeLineDecoder((line) => {
    try {
      handleServerMsg(JSON.parse(line) as ServerMsg);
    } catch {
      /* malformed line — ignore */
    }
  });
  s.on("data", decode);
  s.on("close", () => {
    if (conn === s) conn = null;
    // The socket dropped (daemon restarted / transient error). Two repairs:
    //  1) Fail any in-flight attach NOW instead of making spawnPty wait the full
    //     6s timeout for a socket that's already gone.
    //  2) Proactively RE-attach every live session — data flows daemon→client,
    //     so nothing else would re-trigger ensureConn and the tiles would go
    //     silently dead until the user typed.
    for (const [reqId, resolve] of [...pendingAttach]) {
      pendingAttach.delete(reqId);
      resolve({ pid: -1 });
    }
    if (cbs.size > 0) void reattachLive();
  });
  s.on("error", () => {
    /* handled via close */
  });
}

/** Reconnect and re-issue `attach` for every still-live session after a drop. */
async function reattachLive(): Promise<void> {
  if (reattaching || cbs.size === 0) return;
  reattaching = true;
  try {
    await ensureConn();
    for (const [id, spec] of specs) {
      if (!cbs.has(id)) continue; // detached/killed since the drop
      // Fire-and-forget: the "attached" reply replays buffered output via
      // cbs.get(id).onData; there's no pendingAttach resolver for a re-attach.
      try {
        await send({ t: "attach", reqId: `re${++reqSeq}`, id, spec });
      } catch {
        /* will retry on the next close if the reconnect failed */
      }
    }
  } catch {
    /* daemon unreachable — a later spawn/write will retry the connect */
  } finally {
    reattaching = false;
  }
}

function spawnDaemon(sp: string): void {
  // ELECTRON_RUN_AS_NODE makes Electron run the daemon as plain Node (no
  // Chromium); detached + unref so it outlives this window.
  const child = spawn(process.execPath, [daemonScript(), sp], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function tryConnect(sp: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sp);
    const onErr = (e: Error) => {
      s.destroy();
      reject(e);
    };
    s.once("error", onErr);
    s.once("connect", () => {
      s.removeListener("error", onErr);
      setupConn(s);
      resolve(s);
    });
  });
}

async function doConnect(): Promise<net.Socket> {
  const sp = socketPath();
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await tryConnect(sp);
    } catch {
      if (attempt === 0) spawnDaemon(sp); // first failure → bring the daemon up
      await delay(120);
    }
  }
  throw new Error("pty-daemon unreachable");
}

async function ensureConn(): Promise<net.Socket> {
  if (conn && !conn.destroyed) return conn;
  if (!connecting) {
    connecting = doConnect().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

async function send(msg: ClientMsg): Promise<void> {
  const c = await ensureConn();
  c.write(frame(msg));
}

export async function spawnPty(opts: SpawnOpts, cb: Callbacks): Promise<{ pid: number }> {
  cbs.set(opts.tileId, cb);
  const spec: AttachSpec = {
    cwd: opts.cwd,
    cmd: opts.cmd,
    args: opts.args ?? [],
    cols: opts.cols,
    rows: opts.rows,
    env: opts.env,
  };
  specs.set(opts.tileId, spec); // remembered for re-attach after a socket drop
  const reqId = `r${++reqSeq}`;
  const result = new Promise<{ pid: number }>((resolve) => {
    pendingAttach.set(reqId, resolve);
    // Don't hang the renderer forever if the daemon never answers. unref so this
    // timer never keeps the main event loop alive (would stall app exit).
    const t = setTimeout(() => {
      if (pendingAttach.delete(reqId)) resolve({ pid: -1 });
    }, 6000);
    t.unref?.();
  });
  await send({ t: "attach", reqId, id: opts.tileId, spec });
  return result;
}

export function writePty(tileId: string, data: string): void {
  void send({ t: "write", id: tileId, data });
}
export function resizePty(tileId: string, cols: number, rows: number): void {
  void send({ t: "resize", id: tileId, cols, rows });
}
/** Explicit close (× button): terminate the session in the daemon. */
export function killPty(tileId: string): void {
  cbs.delete(tileId);
  specs.delete(tileId);
  void send({ t: "kill", id: tileId });
}
/** Window closed / tile unmounted: stop streaming but KEEP the session alive. */
export function detachPty(tileId: string): void {
  cbs.delete(tileId);
  specs.delete(tileId); // we won't auto-re-attach a deliberately detached tile
  void send({ t: "detach", id: tileId });
}
/** App quit: sessions PERSIST in the daemon (that's the point) — we don't kill
 *  them, but we DO tear down our client socket so a half-open connection can't
 *  keep the main event loop alive and stall app exit. */
export function killAll(): void {
  if (conn) {
    try {
      conn.destroy();
    } catch {
      /* already gone */
    }
    conn = null;
  }
}
