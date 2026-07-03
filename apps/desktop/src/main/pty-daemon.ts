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
import * as pty from "@lydell/node-pty";
import { SessionManager, type ManagedPty, type SpawnSpec, type SessionSnapshot } from "./pty-session-manager.js";
import { type ClientMsg, type ServerMsg, frame, makeLineDecoder } from "./pty-protocol.js";
import { evictTrackedSession, trackerSource } from "./tile-session-store.js";
import { sanitizeShellEnv } from "./shell-env.js";
import { composeResume } from "./providers/registry.js";
import { planHookSource } from "./plan-review-hook-source.js";
import { stopHookSource } from "./hcp/stop-hook-source.js";
import { piExtSource } from "./hcp/pi-ext-source.js";
import { approvalHookSource } from "./hcp/approval-hook-source.js";
import { subagentHookSource } from "./hcp/subagent-hook-source.js";
import { notificationHookSource } from "./hcp/notification-hook-source.js";
import { userpromptHookSource } from "./hcp/userprompt-hook-source.js";
import { seedDroidHome } from "./hcp/droid-home.js";
import { droidHooksSettings } from "./droid-resume.js";
import { readOrCreateToken, hcpSockPath } from "./hcp/token.js";

const socketPath = process.argv[2] || process.env.HIVEMIND_PTY_SOCK;
// Captured ONCE at startup: the mtime of the daemon script this process is
// running. Reported on `ping` so the app can detect a rebuild (the on-disk
// script is newer than what we loaded) and replace us with a fresh daemon.
// CONTENT hash (FNV-1a) of our own bundle — NOT mtime. A rebuild that doesn't
// change the daemon's code keeps the same stamp, so a renderer/main-only rebuild
// won't make the app respawn us and tear down live claude sessions. Must match
// daemon-client.ts's currentBuildStamp() byte-for-byte.
const BUILD_STAMP = (() => {
  try {
    const b = fs.readFileSync(process.argv[1] ?? "");
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]!; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  } catch { return 0; }
})();
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

// ── live claude session tracking ───────────────────────────────────────────
// hivemind spawns `claude --session-id <uuid>`, but the user can switch the
// ACTIVE session inside the tile (`/resume`, `--continue`, claude reassigning
// its id). To resume what the tile is ACTUALLY in, we inject a merged
// SessionStart hook (fires on start/resume/clear) that records
// tileId → live session_id into tile-sessions.json. On restore we prefer that
// tracked id over the originally-injected one. The hook command bakes in the
// tile id (HIVEMIND_TILE) so it's correct even with several claude tiles in one
// cwd. The tracker runs as electron-as-node (.cjs forces CommonJS).
const userDataDir = path.dirname(socketPath);
// Legacy single-map file — read-only now (migration fallback in trackedSession).
const tileSessionsPath = path.join(userDataDir, "tile-sessions.json");
// Per-tile directory — each claude tile records its live session id in its OWN
// file, so concurrent SessionStart hooks (every frame's claude tile on restart)
// never clobber each other. See tile-session-store.ts for the why.
const tileSessionsDir = path.join(userDataDir, "tile-sessions");
const trackerPath = path.join(userDataDir, "tile-session-tracker.cjs");
try { fs.writeFileSync(trackerPath, trackerSource()); } catch { /* best-effort */ }

// Plan review: the daemon writes the PreToolUse(ExitPlanMode) hook script; the
// SOCKET is owned by Electron main (it alone can drive the canvas). Both sides
// derive the same socket path from userDataDir, so no extra arg-passing. main
// binds the bridge in plan-bridge.ts.
const planHookPath = path.join(userDataDir, "plan-review-hook.cjs");
const planBridgeSock = path.join(userDataDir, "plan-bridge.sock");
try { fs.writeFileSync(planHookPath, planHookSource()); } catch { /* best-effort */ }

// HCP: the daemon writes the Stop hook (turn reporter) and shares the control-
// plane socket + capability token with Electron main (both derive the socket
// path from userDataDir; the token file is read/created by whichever starts
// first). Injected into spawned claude tiles via claude-resume.
const stopHookPath = path.join(userDataDir, "hcp-stop-hook.cjs");
try { fs.writeFileSync(stopHookPath, stopHookSource()); } catch { /* best-effort */ }
// Permission-broker hook (HCP Phase 6) — injected ONLY for supervised workers.
const approvalHookPath = path.join(userDataDir, "hcp-approval-hook.cjs");
try { fs.writeFileSync(approvalHookPath, approvalHookSource()); } catch { /* best-effort */ }
// Subagent lifecycle hook — marks a tile "working" while it has in-flight
// (incl. background) Task subagents, the case the screen-scrape misses.
const subagentHookPath = path.join(userDataDir, "hcp-subagent-hook.cjs");
try { fs.writeFileSync(subagentHookPath, subagentHookSource()); } catch { /* best-effort */ }
// Notification hook — relays claude's "needs your permission/input" signal so a
// deterministic "needs you" status hardens the screen-scrape.
const notificationHookPath = path.join(userDataDir, "hcp-notification-hook.cjs");
try { fs.writeFileSync(notificationHookPath, notificationHookSource()); } catch { /* best-effort */ }
// UserPromptSubmit hook — turn START → working (hook-driven status; pairs with Stop).
const userpromptHookPath = path.join(userDataDir, "hcp-userprompt-hook.cjs");
try { fs.writeFileSync(userpromptHookPath, userpromptHookSource()); } catch { /* best-effort */ }
// pi lifecycle-bridge extension — pi has no hook system but loads an ESM
// extension via `pi -e`; this bridges pi's agent_start/message_end/agent_end to
// HCP so a pi tile reports turn/status/reply like claude's Stop hook. Injected
// into spawned pi tiles via pi-resume (env + `-e` arg). Best-effort write.
const piExtPath = path.join(userDataDir, "hive-pi-ext.mjs");
try { fs.writeFileSync(piExtPath, piExtSource()); } catch { /* best-effort */ }
const hcpSock = hcpSockPath(userDataDir);
const hcpToken = readOrCreateToken(userDataDir);

// Droid (Factory) deterministic hooks: droid has no inline `--settings`, so we
// point it at an EPHEMERAL FACTORY_HOME_OVERRIDE home (seeded with symlinks to
// the real ~/.factory + our hooks.json) — never touching the user's ~/.factory.
// The hooks.json reuses the SAME HCP hook scripts (droid's Stop carries
// transcript_path like claude). Best-effort: a seed failure just disables droid
// hooks (the screen-scrape detector still drives status).
const droidHome = path.join(userDataDir, "droid-home");
try {
  seedDroidHome({
    droidHome,
    hooks: droidHooksSettings({ execPath: process.execPath, stopHookPath, userpromptHookPath, notificationHookPath, hcpSock }),
  });
} catch { /* best-effort */ }

// Provider spawn transforms (resume + deterministic-signal hook injection),
// composed across every registered agent provider (claude, codex, …). Each
// provider no-ops for specs it doesn't own, so the composition is order-safe.
// To add a provider: implement it under providers/ and register it — no change
// here. The transforms are electron-free (in claude-resume.ts / codex-resume.ts),
// so they stay unit-testable with a fake agent; the daemon just supplies paths.
const resume = composeResume({
  trackerPath,
  tileSessionsDir,
  legacyMapFile: tileSessionsPath,
  execPath: process.execPath,
  planHookPath,
  planBridgeSock,
  stopHookPath,
  approvalHookPath,
  subagentHookPath,
  notificationHookPath,
  userpromptHookPath,
  hcpSock,
  hcpToken,
  piExtPath,
  droidHome,
});

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
  // Drop the tile's per-tile tracked-session file so killed tiles don't leave
  // stale ids behind.
  evictTrackedSession(tileSessionsDir, id);
  // Legacy cleanup: also remove the entry from the old shared map if present.
  try {
    const map = JSON.parse(fs.readFileSync(tileSessionsPath, "utf8"));
    if (map && id in map) {
      delete map[id];
      const tmp = `${tileSessionsPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(map));
      fs.renameSync(tmp, tileSessionsPath);
    }
  } catch { /* no map yet / unreadable — nothing to clean */ }
}
function loadAllSnapshots(): SessionSnapshot[] {
  const out: SessionSnapshot[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(sessionsDir, name);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const snap = JSON.parse(raw) as SessionSnapshot;
      // Basic shape sanity — old/corrupt snapshots are silently dropped.
      if (!snap || typeof snap.id !== "string" || typeof snap.replay !== "string" || !snap.spec) {
        continue;
      }
      // Legacy key shape (`hm:<absolute-path>:<tileId>` — 3+ colon-segments
      // after `hm:`). The new key is `hm:<tileId>` (single segment). No
      // renderer asks for the legacy id anymore — they'd be loaded into the
      // frozen map every daemon boot and never attached, leaking memory
      // forever. Drop both the in-memory load AND the on-disk file.
      if (snap.id.startsWith("hm:") && snap.id.slice(3).split(":").length > 1) {
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
        continue;
      }
      out.push(snap);
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
  const env: Record<string, string> = sanitizeShellEnv({
    ...(process.env as Record<string, string>),
    ...(spec.env ?? {}),
  });
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
  // claude resume/tracking: see claude-resume.ts. BIND-AT-SPAWN injects a
  // deterministic `--session-id <uuid>` (stored in the snapshot args) + the
  // SessionStart tracker; restore prefers the tracked live id (follows
  // `/resume`) then swaps `--session-id` → `--resume`; a retry transform turns
  // "No conversation found" into a fresh `--session-id` session so a missing
  // JSONL doesn't kill the tile. Limitations inherited from claude itself
  // (can't fix from the PTY layer): killed mid-tool-call (#18880), post-`cd`
  // mid-session (#22566), version-upgrade across resume (#53417).
  // Composed across all registered providers (each no-ops for specs it doesn't
  // own): spawn binds claude's session id + injects its signal hooks; restore
  // chains claude then codex; retry turns "No conversation found" into a fresh
  // session. Limitations inherited from claude itself (can't fix from the PTY
  // layer): killed mid-tool-call (#18880), post-`cd` mid-session (#22566),
  // version-upgrade across resume (#53417).
  transformSpecOnSpawn: resume.transformSpecOnSpawn,
  transformSpecOnRestore: resume.transformSpecOnRestore,
  restoreRetryMs: resume.restoreRetryMs,
  restoreRetryTransform: resume.restoreRetryTransform,
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
// Last-resort net: an un-`.catch`'d rejection anywhere in the daemon (it has no
// renderer to surface errors) would otherwise crash the whole daemon and drop
// every persisted session. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[pty-daemon] unhandledRejection:", reason);
});

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
          })
          .catch((e: unknown) => {
            // Bad cwd / node-pty ABI / ENOENT cmd. Without this catch the
            // promise rejects, no "attached" is ever sent, and the client's
            // pendingAttach hangs until its 6s timeout — with nothing logged.
            // Reply with a failure pid so spawnPty resolves immediately.
            attached.delete(msg.id);
            console.error(`[pty-daemon] attach ${msg.id} failed:`, e);
            send({ t: "attached", reqId: msg.reqId, id: msg.id, pid: -1, isNew: false, replay: "" });
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
        send({ t: "pong", reqId: msg.reqId, buildStamp: BUILD_STAMP });
        break;
      case "shutdown":
        // The app detected a rebuild and is replacing us. Sessions persist via
        // their on-disk snapshots; the fresh daemon replays + respawns them.
        process.exit(0);
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
