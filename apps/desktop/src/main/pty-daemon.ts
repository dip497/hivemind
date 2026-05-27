/**
 * PTY daemon — a long-lived process the Electron main spawns (via
 * ELECTRON_RUN_AS_NODE) so terminal sessions survive the window closing.
 * Owns all node-pty sessions through SessionManager and speaks NDJSON over a
 * Unix domain socket. See research/persistence-plan.md.
 *
 * Spawned as: electron <this> <socketPath>  with ELECTRON_RUN_AS_NODE=1.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "@lydell/node-pty";
import { SessionManager, type ManagedPty, type SpawnSpec, type SessionSnapshot } from "./pty-session-manager.js";
import { type ClientMsg, type ServerMsg, frame, makeLineDecoder } from "./pty-protocol.js";

const socketPath = process.argv[2] || process.env.HIVEMIND_PTY_SOCK;
if (!socketPath) {
  console.error("[pty-daemon] no socket path given");
  process.exit(1);
}

// Disk snapshots — survive daemon death + OS reboot. Stored next to the socket
// under <userData>/sessions/<base64url-id>.json. The PTY itself can't be
// reconstructed across reboot, but the VISIBLE STATE can: on first attach,
// the daemon replays the snapshot AND spawns a fresh PTY with the stored spec
// so the user sees their last screen + a working shell taking over.
const sessionsDir = path.join(path.dirname(socketPath), "sessions");
try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch { /* ignore */ }
const snapshotPath = (id: string): string => {
  // URL-safe base64 of the id so any character (including ':') is path-safe.
  const safe = Buffer.from(id).toString("base64url");
  return path.join(sessionsDir, `${safe}.json`);
};
function persistSnapshot(id: string, snap: SessionSnapshot): void {
  const p = snapshotPath(id);
  try {
    // Atomic-ish: write to a sibling tmp then rename (avoids torn JSON if the
    // process is killed mid-write — partial file would fail JSON.parse on
    // next boot and the session would be lost otherwise).
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap), "utf8");
    fs.renameSync(tmp, p);
  } catch {
    /* disk full / readonly fs — session loses reboot survival, that's it */
  }
}
function evictSnapshot(id: string): void {
  try { fs.unlinkSync(snapshotPath(id)); } catch { /* already gone */ }
}
function loadAllSnapshots(): SessionSnapshot[] {
  const out: SessionSnapshot[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, name), "utf8");
      const snap = JSON.parse(raw) as SessionSnapshot;
      // Basic shape sanity — old/corrupt snapshots are silently dropped.
      if (snap && typeof snap.id === "string" && typeof snap.replay === "string" && snap.spec) {
        out.push(snap);
      }
    } catch {
      /* corrupt — skip */
    }
  }
  return out;
}

// Real node-pty factory. Mirrors pty-host.doSpawn's env defaults so colors,
// locale, and TERM_PROGRAM match the in-process path. UUID injection happens
// in transformSpecOnSpawn (so the snapshot persists it) — by the time spec
// reaches here, the args already carry `--session-id <uuid>` for claude.
const factory = (spec: SpawnSpec): ManagedPty => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(spec.env ?? {}),
  };
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  if (!env.LANG) env.LANG = "C.UTF-8";
  if (!env.TERM_PROGRAM) env.TERM_PROGRAM = "hivemind";
  const p = pty.spawn(spec.cmd, spec.args ?? [], {
    cwd: spec.cwd,
    cols: spec.cols,
    rows: spec.rows,
    name: "xterm-256color",
    env,
  });
  return {
    get pid() {
      return p.pid;
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: (sig) => p.kill(sig),
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(({ exitCode, signal }) => cb(exitCode, signal)),
  };
};

const manager = new SessionManager(factory, {
  idleMs: 8000, // exit 8s after the last session is killed/exits — no orphans
  onEmpty: () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  },
  onSnapshot: persistSnapshot,
  onSnapshotEvict: evictSnapshot,
  // BIND-AT-SPAWN: every fresh claude session gets a hivemind-generated UUID
  // via `--session-id`. The UUID is stored in the snapshot's args, so restore
  // is deterministic — no `--continue` lottery (which silently starts fresh
  // on miss, anthropics/claude-code #10063), no `~/.claude/projects/` polling
  // to discover the id. Falls back to `--continue` if the snapshot pre-dates
  // this binding (i.e. legacy snapshots from before today's build).
  // Limitations still inherited from claude itself (cannot fix from PTY layer):
  //   - Killed MID-TOOL-CALL → JSONL ends with tool_use, --resume crashes (#18880).
  //   - Post-`cd` mid-session → persistence stops (#22566).
  //   - Version-upgrade across resume → silent persistence loss (#53417).
  transformSpecOnSpawn: (spec) => {
    const cmd = (spec.cmd ?? "").split("/").pop();
    if (cmd !== "claude") return spec;
    const args = spec.args ?? [];
    // User-provided session control wins (--session-id, --resume, --continue,
    // --from-pr) — those are explicit overrides.
    const claimed = args.some((a) =>
      a === "--session-id" || a === "--resume" || a === "-r" ||
      a === "--continue" || a === "-c" || a === "--from-pr",
    );
    if (claimed) return spec;
    return { ...spec, args: ["--session-id", randomUUID(), ...args] };
  },
  transformSpecOnRestore: (spec) => {
    const cmd = (spec.cmd ?? "").split("/").pop();
    if (cmd !== "claude") return spec;
    const args = spec.args ?? [];
    // KEEP `--session-id <uuid>` on restore (do NOT swap to `--resume`).
    //
    // Earlier this swapped `--session-id <uuid>` → `--resume <uuid>` to get a
    // loud error when claude's .jsonl was missing. That loud error crashed
    // the tile dead: "No conversation found with session ID: …" → exit code 1
    // → blank tile until manual restart. Common causes that hit the user:
    //   - claude config / sessions dir wiped between reboots
    //   - claude major-version upgrade rewrote session storage
    //   - user signed out & back in
    //   - first-run on a fresh machine (the snapshot survives, the JSONL
    //     was never there).
    //
    // `--session-id <uuid>` is idempotent in claude: if the JSONL exists it
    // RESUMES, if not it CREATES a new session with that exact id. Same
    // deterministic-id guarantee, no crash on miss. Documented in
    // anthropics/claude-code CLI reference.
    if (args.includes("--session-id")) return spec;
    // Legacy snapshot (pre-bind era) had no `--session-id` — fall back to
    // --continue best-effort.
    const claimed = args.some((a) =>
      a === "--resume" || a === "-r" || a === "--continue" || a === "-c",
    );
    if (claimed) return spec;
    return { ...spec, args: ["--continue", ...args] };
  },
});

// Reboot-restore: hydrate any snapshots written by a previous daemon. They
// stay frozen (no live PTY) until a renderer attaches — only then is a fresh
// PTY spawned with the stored spec. Idle-exit is held off because frozen
// sessions count as "available" (size > 0 is not enough — frozen.size is
// tracked separately by the manager).
for (const snap of loadAllSnapshots()) manager.restoreSnapshot(snap);

// Graceful shutdown — flush any unwritten snapshots before exit so the last
// ~2s of activity (the debounce window) survives an orderly daemon termination.
// MUST await: flushAll resolves only after every xterm-drain callback fires
// + the corresponding persistSnapshot completes. A sync `process.exit(0)` here
// would kill the event loop before any callback ran → snapshots silently lost
// (the bug shipped in the prior diff). `process.on("exit")` is intentionally
// NOT registered — that listener is sync-only per Node docs and can't await.
const flushOnExit = async (): Promise<void> => {
  try { await manager.flushAll(); } catch { /* ignore */ }
};
process.on("SIGTERM", () => { void flushOnExit().then(() => process.exit(0)); });
process.on("SIGINT", () => { void flushOnExit().then(() => process.exit(0)); });

// Clean up a stale socket from a previous (crashed) daemon before binding.
try {
  fs.unlinkSync(socketPath);
} catch {
  /* not present — fine */
}

const server = net.createServer((sock) => {
  const send = (msg: ServerMsg) => {
    if (!sock.destroyed) sock.write(frame(msg));
  };
  // Sessions this connection attached — detached (NOT killed) when it drops,
  // so closing the window leaves the processes running.
  const attached = new Set<string>();

  const onLine = makeLineDecoder((line) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(line) as ClientMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "attach": {
        attached.add(msg.id);
        void manager
          .createOrAttach(msg.id, msg.spec, {
            onData: (data) => send({ t: "data", id: msg.id, data }),
            onExit: (code, signal) =>
              send({ t: "exit", id: msg.id, code, signal: signal ?? null }),
          })
          .then((r) => {
            send({ t: "attached", reqId: msg.reqId, id: msg.id, pid: r.pid, isNew: r.isNew, replay: r.replay });
          });
        break;
      }
      case "write":
        manager.write(msg.id, msg.data);
        break;
      case "resize":
        manager.resize(msg.id, msg.cols, msg.rows);
        break;
      case "detach":
        attached.delete(msg.id);
        manager.detach(msg.id);
        break;
      case "kill":
        attached.delete(msg.id);
        manager.kill(msg.id);
        break;
      case "list":
        send({ t: "sessions", reqId: msg.reqId, ids: manager.list() });
        break;
      case "ping":
        send({ t: "pong", reqId: msg.reqId });
        break;
    }
  });

  sock.on("data", onLine);
  sock.on("error", () => {
    /* client vanished mid-write — ignore */
  });
  sock.on("close", () => {
    // Window closed: detach (keep processes alive). Never kill on disconnect.
    for (const id of attached) manager.detach(id);
    attached.clear();
  });
});

server.on("error", (e) => {
  console.error("[pty-daemon] server error:", e);
  process.exit(1);
});

server.listen(socketPath, () => {
  // stdout is ignored by the parent, but useful when run manually for debugging.
  console.error(`[pty-daemon] listening on ${socketPath} (pid ${process.pid})`);
});

// If nothing ever connects (parent died right after spawn), don't linger.
// Frozen sessions (loaded from disk) DON'T keep the daemon alive on boot —
// without a live client they'd just rot in memory. They stay safe on disk;
// the next daemon boot reloads them. `manager.list().length` covers both
// live AND frozen for fairness with other call sites.
const bootGuard = setTimeout(() => {
  if (manager.size() === 0) {
    // Flush any snapshots that were dirty (shouldn't be any — frozen aren't
    // dirty — but cheap insurance), then exit. Async-await so the snapshot
    // write completes before the process dies.
    void manager.flushAll().finally(() => process.exit(0));
  }
}, 30000);
bootGuard.unref?.();
