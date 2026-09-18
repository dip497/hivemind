/**
 * PTY daemon — a long-lived process the Electron main spawns (via
 * ELECTRON_RUN_AS_NODE) so terminal sessions survive the window closing.
 * Owns all node-pty sessions through SessionManager and speaks NDJSON over a
 * Unix domain socket. See research/persistence-plan.md.
 *
 * Spawned as: electron <this> <socketPath>  with ELECTRON_RUN_AS_NODE=1.
 * Without the desktop app: `hive daemon start` runs this same file inside `hive`.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { homedir, hostname } from "node:os";
import { createRequire } from "node:module";
import type * as NodePty from "@lydell/node-pty";
import * as bunPty from "./bun-pty.js";
import { listenExclusive } from "./socket-claim.js";
import { SessionManager, type ManagedPty, type SpawnSpec, type SessionSnapshot, type SessionClient } from "./pty-session-manager.js";
import { type ClientMsg, type ServerMsg, frame, makeLineDecoder } from "./pty-protocol.js";
import { PtyOutputBuffer } from "./pty-output-buffer.js";
import { ipcPath, repairShellSpec } from "./platform.js";
import {
  fileNameForId, listSnapshotFiles, readSnapshot, redactSnapshot, rehydrateSnapshot, secureDir,
  staleSnapshotIds, type SnapshotEntry,
} from "./session-snapshot-store.js";
import { applyInitialPrompt, stripInitialPrompt } from "../shared/agent-io.js";
import { sanitizeShellEnv } from "./shell-env.js";
import { composeResume, evictTrackedSession, prepareProviders, trackerSource, setCatalog } from "@hivemind/agents/node";
import { planHookSource } from "./plan-review-hook-source.js";
import { stopHookSource } from "./hcp/stop-hook-source.js";
import { approvalHookSource } from "./hcp/approval-hook-source.js";
import { subagentHookSource } from "./hcp/subagent-hook-source.js";
import { notificationHookSource } from "./hcp/notification-hook-source.js";
import { userpromptHookSource } from "./hcp/userprompt-hook-source.js";
import { readOrCreateToken, hcpSockPath } from "./hcp/token.js";

// Lazy: node-pty must never be evaluated inside the compiled `hive` (see bun-pty.ts).
const spawnPty: (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; name: string; env: Record<string, string> }) => {
  readonly pid: number; write(d: string): void; resize(c: number, r: number): void; kill(sig?: string): void;
  pause(): void; resume(): void; onData(cb: (d: string) => void): unknown; onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
} = process.versions.bun
  ? bunPty.spawn
  : (createRequire(import.meta.url)("@lydell/node-pty") as typeof NodePty).spawn;

const socketPath = process.argv[2] || process.env.HIVEMIND_PTY_SOCK;
// Set by `hive daemon` (no desktop on this machine); removed so sessions don't inherit it.
const STANDALONE = process.env.HIVEMIND_DAEMON_STANDALONE === "1";
delete process.env.HIVEMIND_DAEMON_STANDALONE;
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
// Every file this daemon emits (hook scripts, the pi extension, session
// snapshots, the HCP socket + token) lives NEXT TO the socket. A relative
// socket path would make all of that land in whatever the launcher's cwd is —
// a stray `undefined/hive-pi-ext.mjs` in a repo root was exactly that — so
// refuse anything but an absolute path instead of writing into the cwd.
if (!path.isAbsolute(socketPath)) {
  console.error(`[pty-daemon] socket path must be absolute (got ${JSON.stringify(socketPath)})`);
  process.exit(1);
}

// Disk snapshots — survive daemon death + OS reboot. Stored next to the socket
// under <userData>/sessions/<base64url-id>.json. The PTY itself can't be
// reconstructed across reboot, but the VISIBLE STATE can: on first attach,
// the daemon replays the snapshot AND spawns a fresh PTY with the stored spec
// so the user sees their last screen + a working shell taking over.
const sessionsDir = path.join(path.dirname(socketPath), "sessions");
secureDir(sessionsDir);

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

// Hooks run as `<execPath> hook.cjs`; a compiled `hive` needs BUN_BE_BUN for that, set only
// in this wrapper — in the agent's env it would turn every `hive ctl` into bun.
const hookExecPath = (() => {
  const compiledHive = !!process.versions.bun && !/(^|[/\\])bun(\.exe)?$/.test(process.execPath);
  if (!compiledHive) return process.execPath;
  const wrapper = path.join(userDataDir, "hive-hook-runtime");
  const quoted = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
  try {
    fs.writeFileSync(wrapper, `#!/bin/sh\nBUN_BE_BUN=1 exec ${quoted} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
  } catch { /* best-effort: status falls back to the screen scrape */ }
  return wrapper;
})();

// Plan review: the daemon writes the PreToolUse(ExitPlanMode) hook script; the
// SOCKET is owned by Electron main (it alone can drive the canvas). Both sides
// derive the same socket path from userDataDir, so no extra arg-passing. main
// binds the bridge in plan-bridge.ts.
const planHookPath = path.join(userDataDir, "plan-review-hook.cjs");
const planBridgeSock = ipcPath(userDataDir, "plan-bridge.sock");
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
const hcpSock = hcpSockPath(userDataDir);
const hcpToken = readOrCreateToken(userDataDir);

// Provider-owned assets + config-home overlays (the pi bridge extension, the
// droid FACTORY_HOME_OVERRIDE overlay, the kiro KIRO_HOME overlay + its own
// approval hook, …): every catalogued provider's `prepare()` runs here and
// hands back ITS private paths, which the spawn transforms read under
// ctx.providers[id]. Best-effort per provider — a failure only disables that
// provider's deterministic signals (the screen-scrape detector still drives
// status). Nothing here names a provider.
// The agents this machine has, not only the ones compiled in: an agent someone installed
// asks for its files and its hooks in exactly the same way, and this is the process that
// does that work. Best-effort — if the scan fails the compiled-in list stands, which is a
// daemon missing one agent's signals rather than a daemon that will not start.
// The daemon outlives installs: a changed agents dir (install and remove both rename entries in it) triggers a rescan before a spawn.
const dirMtime = (dir: string): number | undefined => {
  try { return fs.statSync(dir).mtimeMs; } catch { return undefined; }
};
const providerCtx = {
  userDataDir,
  execPath: hookExecPath,
  trackerPath,
  tileSessionsDir,
  legacyMapFile: tileSessionsPath,
  stopHookPath,
  planHookPath,
  planBridgeSock,
  approvalHookPath,
  subagentHookPath,
  userpromptHookPath,
  notificationHookPath,
  hcpSock,
  hcpToken,
};
let providerPaths: Record<string, Record<string, string>> = {};
// Rebound by a rescan; the manager reads them through these variables.
let resume = composeResume({ ...providerCtx, providers: providerPaths });
let ensureAgentsCurrent: () => Promise<void> = async () => {};
try {
  const [{ loadAgents, userAgentsDir }] = await Promise.all([import("@hivemind/agents/load")]);
  let agentsStamp: number | undefined;
  let rescan: Promise<void> | undefined;
  const reloadAgents = async (): Promise<void> => {
    // Stamped before the scan, so an install that lands during it still triggers the next one.
    agentsStamp = dirMtime(userAgentsDir());
    const { defs } = await loadAgents();
    setCatalog(defs);
    providerPaths = prepareProviders(providerCtx);
    resume = composeResume({ ...providerCtx, providers: providerPaths });
  };
  ensureAgentsCurrent = () => {
    if (dirMtime(userAgentsDir()) === agentsStamp) return Promise.resolve();
    // Best-effort like the boot scan: a failed rescan spawns with the catalog we have.
    return (rescan ??= reloadAgents().catch((e: unknown) => {
      console.error("[pty-daemon] agent rescan failed:", (e as Error).message);
    }).finally(() => { rescan = undefined; }));
  };
  await reloadAgents();
} catch (e) {
  console.error("[pty-daemon] agent scan skipped:", (e as Error).message);
  providerPaths = prepareProviders(providerCtx);
  resume = composeResume({ ...providerCtx, providers: providerPaths });
}

// Provider spawn transforms (resume + deterministic-signal hook injection):
// composed across every catalogued provider (@hivemind/agents) in reloadAgents
// above, and recomposed there on a rescan.

const snapshotPath = (id: string): string => path.join(sessionsDir, fileNameForId(id));
// One write chain per session id so a later snapshot can never land on disk
// before an earlier one (the writes are async now — see persistSnapshot).
const snapshotWrites = new Map<string, Promise<void>>();
// The NEWEST unwritten body per id. A chained task writes whatever is latest
// when it runs, so a disk slower than the debounce doesn't queue up (and hold
// in memory) a stack of superseded multi-MB replays — only the last one lands.
const snapshotLatest = new Map<string, string>();
/** Settle every in-flight snapshot write/evict (exit paths await this). */
const settleSnapshotWrites = (): Promise<unknown> => Promise.allSettled([...snapshotWrites.values()]);
function persistSnapshot(id: string, snap: SessionSnapshot): Promise<void> {
  const p = snapshotPath(id);
  // ASYNC fs. The daemon is one thread relaying EVERY tile's output; a sync
  // write of a multi-MB replay blocked that relay for every session (visible
  // as all terminals stuttering together whenever one tile went quiet for 2s
  // on a busy disk). The serialize itself is still CPU, but the disk wait no
  // longer stalls the socket.
  snapshotLatest.set(id, JSON.stringify(redactSnapshot(snap)));
  const prev = snapshotWrites.get(id) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const body = snapshotLatest.get(id);
      if (body === undefined) return; // an earlier task already wrote a newer body
      snapshotLatest.delete(id);
      // Atomic-ish: write to a sibling tmp then rename (avoids torn JSON if the
      // process is killed mid-write — partial file would fail JSON.parse on
      // next boot and the session would be lost otherwise).
      const tmp = `${p}.tmp`;
      await fs.promises.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
      await fs.promises.rename(tmp, p);
    })
    .catch(() => {
      /* disk full / readonly fs — session loses reboot survival, that's it */
    })
    .finally(() => {
      if (snapshotWrites.get(id) === next) snapshotWrites.delete(id);
    });
  snapshotWrites.set(id, next);
  return next;
}
function evictSnapshot(id: string): void {
  // Chain the unlink behind any in-flight write for this id: with async
  // persistence, an unlink that raced a pending write's rename would let the
  // killed session's file reappear on disk and resurrect it on the next boot.
  const p = snapshotPath(id);
  snapshotLatest.delete(id); // a queued write for a killed session must not land
  const prev = snapshotWrites.get(id) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await fs.promises.unlink(p).catch(() => { /* already gone */ });
      await fs.promises.unlink(`${p}.tmp`).catch(() => { /* none pending */ });
    })
    .finally(() => {
      if (snapshotWrites.get(id) === next) snapshotWrites.delete(id);
    });
  snapshotWrites.set(id, next);
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
function registerSnapshots(): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const entry of listSnapshotFiles(sessionsDir)) {
    // Legacy `hm:<path>:<tileId>` ids are never asked for again.
    if (entry.id.startsWith("hm:") && entry.id.slice(3).split(":").length > 1) {
      try { fs.unlinkSync(entry.file); } catch { /* already gone */ }
      continue;
    }
    manager.restoreLazySnapshot(entry.id, () => {
      const snap = readSnapshot(entry.file, entry.id);
      return snap ? rehydrateSnapshot(snap, hcpToken) : undefined;
    });
    entries.push(entry);
  }
  return entries;
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
  // A ▶ Work prompt (HIVE_INITIAL_PROMPT) becomes claude's trailing positional
  // arg — claude auto-submits it, so no typing race against the booting TUI. The
  // env key is dropped from the child so claude never sees a stray var.
  // A canvas written on another OS can name a shell this one doesn't have.
  const runSpec = repairShellSpec({ cmd: spec.cmd, args: spec.args });
  const { args: execArgs, env: execEnv } = applyInitialPrompt(runSpec.args ?? [], env);
  const p = spawnPty(runSpec.cmd, execArgs, {
    cwd: spec.cwd,
    cols: spec.cols,
    rows: spec.rows,
    name: "xterm-256color",
    env: execEnv,
  });
  return {
    get pid() {
      return p.pid;
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: (sig) => p.kill(sig),
    pause: () => p.pause(),
    resume: () => p.resume(),
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
  transformSpecOnSpawn: (spec, id) => resume.transformSpecOnSpawn(spec, id),
  // Strip the one-time HIVE_INITIAL_PROMPT before ANY provider sees the spec. A
  // restore re-execs from the persisted spec, so an un-stripped prompt is re-appended
  // as positional argv and the task RUNS AGAIN — for every agent that takes an argv
  // prompt (claude, pi). Agent-agnostic on purpose: this is a property of restore.
  transformSpecOnRestore: (spec, id) => resume.transformSpecOnRestore(stripInitialPrompt(spec), id),
  restoreRetryMs: resume.restoreRetryMs,
  restoreRetryTransform: (spec) => resume.restoreRetryTransform(spec),
});

// Reboot-restore: hydrate any snapshots written by a previous daemon. They
// stay frozen (no live PTY) until a renderer attaches — only then is a fresh
// PTY spawned with the stored spec. Idle-exit is held off because frozen
// sessions count as "available" (size > 0 is not enough — frozen.size is
// tracked separately by the manager).
const bootSnapshots = registerSnapshots();

// Open canvases attach within seconds, so anything unclaimed after this is a candidate.
const RETENTION_GRACE_MS = 5 * 60 * 1000;
const retentionTimer = setTimeout(() => {
  for (const id of staleSnapshotIds(bootSnapshots, manager.frozenIds(), Date.now())) manager.kill(id);
}, RETENTION_GRACE_MS);
retentionTimer.unref?.();

// Graceful shutdown — flush any unwritten snapshots before exit so the last
// ~2s of activity (the debounce window) survives an orderly daemon termination.
// MUST await: flushAll resolves only after every xterm-drain callback fires
// + the corresponding persistSnapshot completes. A sync `process.exit(0)` here
// would kill the event loop before any callback ran → snapshots silently lost
// (the bug shipped in the prior diff). `process.on("exit")` is intentionally
// NOT registered — that listener is sync-only per Node docs and can't await.
const flushOnExit = async (): Promise<void> => {
  try { await manager.flushAll(); } catch { /* ignore */ }
  // flushAll only covers DIRTY live sessions; a write (or a kill's chained
  // unlink) already in flight is a separate promise that process.exit would cut
  // off mid-rename — leaving a stale or resurrected snapshot for the next boot.
  try { await settleSnapshotWrites(); } catch { /* ignore */ }
};
process.on("SIGTERM", () => { void flushOnExit().then(() => process.exit(0)); });
process.on("SIGINT", () => { void flushOnExit().then(() => process.exit(0)); });
// Last-resort net: an un-`.catch`'d rejection anywhere in the daemon (it has no
// renderer to surface errors) would otherwise crash the whole daemon and drop
// every persisted session. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[pty-daemon] unhandledRejection:", reason);
});

// Outgoing `data` frames are coalesced per connection (the same PtyOutputBuffer
// main uses toward the renderer): a streaming TUI emits hundreds of tiny pty
// reads a second, and each one used to be its own JSON.stringify + socket write
// here plus a JSON.parse on the app side. Holding them for a few ms turns that
// into one frame per tile per tick — well under a display frame, so nothing is
// felt, and the per-frame overhead on both event loops drops by an order of
// magnitude during bursts. Size-capped so a starved timer can't grow memory;
// `exit` / `attached` flush their tile first to keep ordering.
/** Connections that asked for agent hook events (desktops viewing this machine). */
const eventViewers = new Set<(m: ServerMsg) => void>();

// Pushes to the user's phone: ntfy or any endpoint that takes a plain-text POST (`hive push set`).
const pushFile = path.join(userDataDir, "push.json");
const lastPush = new Map<string, number>();
async function notifyPush(topic: string, data: unknown): Promise<void> {
  let cfg: { url?: unknown; events?: unknown };
  try { cfg = JSON.parse(fs.readFileSync(pushFile, "utf8")); } catch { return; }
  if (typeof cfg.url !== "string" || !/^https?:\/\//.test(cfg.url)) return;
  const events = Array.isArray(cfg.events) ? cfg.events : ["notification"];
  if (!events.includes(topic)) return;
  const tileId = (data as { tileId?: unknown } | null)?.tileId;
  const key = `${String(tileId)}:${topic}`;
  const now = Date.now();
  if ((lastPush.get(key) ?? 0) > now - 15_000) return;
  lastPush.set(key, now);
  const info = manager.info().find((x) => x.id === tileId);
  const what = (info?.title || info?.cmd || "an agent").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80);
  const body = topic === "notification" ? `${what} needs your input` : topic === "turn" ? `${what} finished its turn` : `${what}: ${topic}`;
  try {
    await fetch(cfg.url, { method: "POST", body, headers: { Title: `hivemind - ${hostname()}` }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.error("[pty-daemon] push failed:", e instanceof Error ? e.message : e);
  }
}

const DATA_FLUSH_MS = 4;
const DATA_FLUSH_BYTES = 256 * 1024;
/** Unsent bytes a resync-capable viewer may queue before it is sent a fresh screen instead. */
const BEHIND_BYTES = 1024 * 1024;

const server = net.createServer((sock) => {
  const send = (msg: ServerMsg) => {
    if (!sock.destroyed) sock.write(frame(msg));
  };
  // A slow link must never stall the process: a viewer that can resync drops what it cannot
  // take and is sent the current screen once the socket drains.
  let canResync = false;
  const behind = new Set<string>();
  const resyncing = new Set<string>();
  // Bytes of resync screens still queued: they alone must not push live output behind again.
  let floor = 0;
  const lastSeq = new Map<string, number>();
  const outBuf = new PtyOutputBuffer(
    (id, data) => {
      if (behind.has(id)) return;
      if (canResync && sock.writableLength > floor + BEHIND_BYTES) { behind.add(id); return; }
      send({ t: "data", id, data, seq: lastSeq.get(id) });
    },
    { delayMs: DATA_FLUSH_MS, maxBytes: DATA_FLUSH_BYTES },
  );
  sock.on("drain", () => {
    floor = 0;
    for (const id of behind) {
      if (resyncing.has(id)) continue;
      resyncing.add(id);
      void manager.snapshot(id).then((snap) => {
        // Sent in the serialize callback's turn: nothing emitted after it is lost or doubled.
        resyncing.delete(id);
        behind.delete(id);
        outBuf.forget(id);
        if (snap && viewers.has(id)) { send({ t: "resync", id, ...snap }); floor = sock.writableLength; }
      });
    }
  });
  // This connection's viewer per session; dropping it detaches only this viewer, never kills.
  const viewers = new Map<string, SessionClient>();
  const leave = (id: string) => {
    const v = viewers.get(id);
    viewers.delete(id);
    outBuf.forget(id);
    behind.delete(id);
    lastSeq.delete(id);
    if (v) manager.detach(id, v);
  };

  const onLine = makeLineDecoder((line) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(line) as ClientMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "attach": {
        if (msg.noSpawn && !manager.has(msg.id)) {
          send({ t: "attached", reqId: msg.reqId, id: msg.id, pid: -1, isNew: false, replay: "", error: `no session '${msg.id}'` });
          break;
        }
        // Re-attaching from the same connection replaces its viewer instead of doubling output.
        if (viewers.has(msg.id)) leave(msg.id);
        // Output before `attached` is inside its replay.
        let ready = false;
        const viewer: SessionClient = {
          onData: (data, seq) => { if (seq !== undefined) lastSeq.set(msg.id, seq); if (ready) outBuf.push(msg.id, data); },
          // Final bytes must land before the exit banner.
          onExit: (code, signal) => {
            outBuf.flush(msg.id);
            send({ t: "exit", id: msg.id, code, signal: signal ?? null });
            if (viewers.get(msg.id) === viewer) viewers.delete(msg.id);
          },
        };
        viewers.set(msg.id, viewer);
        const delta = msg.since ? manager.attachDelta(msg.id, viewer, msg.since, msg.spec.cols, msg.spec.rows) : null;
        if (delta) {
          ready = true;
          lastSeq.set(msg.id, delta.seq);
          send({ t: "attached", reqId: msg.reqId, id: msg.id, pid: delta.pid, isNew: false, replay: delta.replay, seq: delta.seq, epoch: delta.epoch, delta: true });
          break;
        }
        // The spawn/restore checkpoint: an agent installed after boot is wired here,
        // before its spec is transformed.
        void ensureAgentsCurrent()
          .then(() => manager.createOrAttach(msg.id, msg.spec, viewer))
          .then((r) => {
            ready = true;
            send({ t: "attached", reqId: msg.reqId, id: msg.id, pid: r.pid, isNew: r.isNew, replay: r.replay, seq: r.seq, epoch: r.epoch });
          })
          .catch((e: unknown) => {
            // Bad cwd / node-pty ABI / ENOENT cmd. Without this catch the
            // promise rejects, no "attached" is ever sent, and the client's
            // pendingAttach hangs until its 6s timeout — with nothing logged.
            // Reply with a failure pid so spawnPty resolves immediately.
            if (viewers.get(msg.id) === viewer) viewers.delete(msg.id);
            console.error(`[pty-daemon] attach ${msg.id} failed:`, e);
            send({ t: "attached", reqId: msg.reqId, id: msg.id, pid: -1, isNew: false, replay: "", error: e instanceof Error ? e.message : String(e) });
          });
        break;
      }
      case "write":
        manager.write(msg.id, msg.data, viewers.get(msg.id));
        break;
      case "resize":
        manager.resize(msg.id, msg.cols, msg.rows, viewers.get(msg.id));
        break;
      case "detach":
        leave(msg.id);
        break;
      case "kill": {
        const killer = viewers.get(msg.id);
        viewers.delete(msg.id);
        outBuf.forget(msg.id);
        manager.kill(msg.id, killer);
        break;
      }
      case "pause":
        manager.pause(msg.id, viewers.get(msg.id));
        break;
      case "resume":
        manager.resume(msg.id, viewers.get(msg.id));
        break;
      case "list":
        send({ t: "sessions", reqId: msg.reqId, ids: manager.list(), ...(msg.detail ? { detail: manager.info() } : {}) });
        break;
      case "ping":
        send({ t: "pong", reqId: msg.reqId, buildStamp: BUILD_STAMP });
        break;
      case "hello":
        canResync = Array.isArray(msg.caps) && msg.caps.includes("resync");
        if (Array.isArray(msg.caps) && msg.caps.includes("events")) eventViewers.add(send);
        break;
      case "shutdown":
        // Stop listening first so the replacement can bind while we flush snapshots.
        try { server.close(); } catch { /* already closed */ }
        void flushOnExit().then(() => process.exit(0));
        break;
    }
  });

  sock.on("data", onLine);
  sock.on("error", () => {
    /* client vanished mid-write — ignore */
  });
  sock.on("close", () => {
    eventViewers.delete(send);
    outBuf.clear();
    // Never kill on disconnect.
    for (const id of Array.from(viewers.keys())) leave(id);
  });
});

const claim = await listenExclusive(server, socketPath).catch((e: unknown) => {
  console.error("[pty-daemon] cannot listen:", e);
  process.exit(1);
});
if (claim === "taken") {
  console.error(`[pty-daemon] another daemon is already listening on ${socketPath}; exiting`);
  process.exit(0);
}
// Owner-only whatever the umask: this socket is a shell as this user.
try { fs.chmodSync(socketPath, 0o600); } catch { /* named pipe on Windows */ }

if (STANDALONE) {
  // No desktop here owns the control-plane socket, so hook events come to us and go on to viewers and push.
  const hcp = net.createServer((c) => {
    c.on("error", () => { /* hook gone */ });
    c.on("data", makeLineDecoder((line) => {
      let m: { t?: unknown; id?: unknown; topic?: unknown; data?: unknown };
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === "event" && typeof m.topic === "string") {
        for (const push of eventViewers) push({ t: "event", topic: m.topic, data: m.data });
        void notifyPush(m.topic, m.data);
      } else if (m.t === "req") {
        // Only a desktop can decide (e.g. approvals): answer at once so the agent falls back to its own prompt.
        c.end(`${JSON.stringify({ t: "res", id: m.id, ok: false, error: { code: "UNAVAILABLE", message: "no desktop on this machine" } })}\n`);
      }
    }));
  });
  void listenExclusive(hcp, hcpSock)
    .then((r) => { if (r === "listening") fs.chmodSync(hcpSock, 0o600); })
    .catch((e: unknown) => console.error("[pty-daemon] control-plane socket unavailable:", e));
}
server.on("error", (e) => {
  console.error("[pty-daemon] server error:", e);
  process.exit(1);
});
// stdout is ignored by the parent, but useful when run manually for debugging.
console.error(`[pty-daemon] listening on ${socketPath} (pid ${process.pid})`);

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
    void flushOnExit().finally(() => process.exit(0));
  }
}, 30000);
bootGuard.unref?.();
