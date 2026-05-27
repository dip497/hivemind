/**
 * Dev HTTP bridge — exposes the SAME main-process adapters (hive-core,
 * git-adapter, pty-host) over HTTP so the renderer can be driven by
 * /gsd-browser without packaging Electron.
 *
 * Nothing here is mocked. The handlers import the same files Electron
 * loads in production; the only difference is the transport (HTTP/SSE
 * instead of Electron IPC).
 *
 * MUST run under Node (via tsx) — NOT bun. bun's loader silently swallows
 * @lydell/node-pty output on Linux (PTYs spawn but stdout never reaches
 * the onData callback, every command appears to exit code=0 signal=1).
 *
 *   pnpm --filter @hivemind/desktop run dev:bridge -- <repoPath>
 *   # which expands to:  tsx src/dev-bridge/server.ts <repoPath>
 *
 * The renderer's `window.hive` is installed by the dev-bridge preload
 * script (served at /hive-bridge.js) which translates the IPC contract
 * into fetch calls + SSE subscriptions.
 */
// Refuse to start under Bun — see comment above. Hard guard so this
// production-equivalence bug doesn't silently regress.
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  console.error(
    "[hivemind dev-bridge] ERROR: this process must run under Node (via tsx), not Bun.",
  );
  console.error(
    "  Bun's loader silently drops @lydell/node-pty output on Linux —",
  );
  console.error(
    "  every PTY spawn appears to exit code=0 signal=1 with zero stdout.",
  );
  console.error("  Restart with:");
  console.error(
    "    pnpm --filter @hivemind/desktop run dev:bridge -- <repoPath>",
  );
  process.exit(1);
}
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  appendActivity,
  commentOnIssue,
  createIssue,
  deleteIssue as deleteIssueCore,
  findRoot,
  listCycles,
  listIssues,
  readIssue,
  updateIssue,
  writeAgentContext,
  writeIssue,
  type IssueState,
} from "@hivemind/core";
import type { IssuePatch } from "@hivemind/core/storage";
import {
  gitCommit,
  gitConflictedFile,
  gitDiff,
  gitDiscard,
  gitFileContents,
  gitListFiles,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  gitWriteResolved,
  worktreeCreate,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "../main/git-adapter";
import { spawnPty, writePty, resizePty, killPty } from "../main/pty-host";
import { applyShellEnvToProcess } from "../main/shell-env";
import chokidar from "chokidar";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { randomBytes } from "node:crypto";

const REPO_PATH = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const PORT = Number(process.env.HIVE_BRIDGE_PORT ?? 5180);
const HOST = "127.0.0.1"; // Linux: loopback only — never expose to LAN.
const RENDERER_DIST = path.resolve(__dirname, "..", "..", "out", "renderer");

// Per-process auth token printed on startup. Renderer's preload.js fetches
// `/auth-token` (LOCAL only — same-origin) once and includes it on every
// /rpc/ and /notify/ call. Defeats CSRF-style "any local origin can spawn
// arbitrary processes" attacks (REVIEW.md CR-01).
const AUTH_TOKEN = randomBytes(32).toString("hex");

// Methods exposed via RPC. ptySpawn is the most dangerous (arbitrary command
// execution) so we require the auth token on it AND any other write methods.
const PROTECTED_METHODS = new Set([
  "ptySpawn",
  "createIssue",
  "updateIssue",
  "deleteIssue",
  "commentOnIssue",
  "updateIssueState",
  "gitStage",
  "gitUnstage",
  "gitDiscard",
  "gitCommit",
  "gitPush",
  "gitWriteResolved",
  "worktreeCreate",
  "worktreeRemove",
  "worktreePrune",
]);

// Set (not Map<"global", Response>) — previously a second SSE subscriber
// would clobber the first because both wrote to ptyStreams.get("global").
// Real bug: open the renderer in a second tab and the first tab's terminals
// went silent. Set lets every subscriber receive every event; per-tab
// filtering happens client-side via the tileId in the payload.
const ptyStreams = new Set<http.ServerResponse>();
const fsStreams = new Set<http.ServerResponse>();

// ── ptySpawn rate limit ─────────────────────────────────────────
// Defense in depth: even with AUTH_TOKEN + loopback-only binding, a
// misbehaving same-origin script could open ptySpawn in a loop and fork-bomb
// the host. 20 spawns / 60s window is generous for any human-driven UI but
// catches runaway loops.
const PTY_SPAWN_LIMIT = 20;
const PTY_SPAWN_WINDOW_MS = 60_000;
const ptySpawnTimestamps: number[] = [];
function ptySpawnAllowed(): boolean {
  const now = Date.now();
  // Drop expired entries
  while (ptySpawnTimestamps.length > 0 && now - ptySpawnTimestamps[0]! > PTY_SPAWN_WINDOW_MS) {
    ptySpawnTimestamps.shift();
  }
  if (ptySpawnTimestamps.length >= PTY_SPAWN_LIMIT) return false;
  ptySpawnTimestamps.push(now);
  return true;
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const PREVIEW_SCRIPT = `
(function() {
  // Use the page's actual origin so localhost↔127.0.0.1 aren't cross-origin
  // (the browser treats them as distinct origins). The server binds to
  // 127.0.0.1 ONLY (loopback), so even if the user types either, every
  // request lands here without going over the network.
  const BRIDGE = window.location.origin;
  // Fetch the per-process auth token ONCE on load. Same-origin = trusted;
  // other apps on the same machine can't read it (CORS blocks cross-origin
  // page reads of localhost in a normal browser context).
  const tokenP = fetch(BRIDGE + "/auth-token", { credentials: "omit" })
    .then((r) => r.json())
    .then((d) => d.token)
    .catch((e) => { console.error("[hivemind] auth-token fetch failed", e); return ""; });
  async function authHeaders() {
    return { "content-type": "application/json", "x-hive-token": await tokenP };
  }
  async function call(method, ...args) {
    const r = await fetch(BRIDGE + "/rpc/" + method, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(await r.text());
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return r.json();
    return undefined;
  }
  function notify(method) {
    return async (...args) => fetch(BRIDGE + "/notify/" + method, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(args),
    });
  }
  // SSE event subscriptions.
  const ptyEvents = {};
  const fsEvents = {};
  const ptyES = new EventSource(BRIDGE + "/events/pty");
  ptyES.onmessage = (ev) => {
    try {
      const { tileId, kind, payload } = JSON.parse(ev.data);
      const list = ptyEvents[tileId + ":" + kind];
      if (list) for (const cb of list) cb(payload);
    } catch (e) { console.error(e); }
  };
  const fsES = new EventSource(BRIDGE + "/events/fs");
  fsES.onmessage = (ev) => {
    try {
      const { repoPath, payload } = JSON.parse(ev.data);
      const list = fsEvents[repoPath];
      if (list) for (const cb of list) cb(payload);
    } catch (e) { console.error(e); }
  };
  function subscribe(map, key, cb) {
    if (!map[key]) map[key] = [];
    map[key].push(cb);
    return () => { map[key] = map[key].filter(x => x !== cb); };
  }
  window.hive = {
    resolveProject:    (h) => call("resolveProject", h),
    listIssues:        (r) => call("listIssues", r),
    readIssue:         (r,i) => call("readIssue", r, i),
    listCycles:        (r) => call("listCycles", r),
    updateIssueState:  (r,i,s,n) => call("updateIssueState", r, i, s, n),
    createIssue:       (r,o) => call("createIssue", r, o),
    updateIssue:       (r,i,p) => call("updateIssue", r, i, p),
    commentOnIssue:    (r,i,m) => call("commentOnIssue", r, i, m),
    deleteIssue:       (r,i) => call("deleteIssue", r, i),
    gitStatus:         (r) => call("gitStatus", r),
    gitListFiles:      (r) => call("gitListFiles", r),
    gitDiff:           (r,s,f) => call("gitDiff", r, s, f),
    gitFileContents:   (r,f,v) => call("gitFileContents", r, f, v),
    gitStage:          (r,f) => call("gitStage", r, f),
    gitUnstage:        (r,f) => call("gitUnstage", r, f),
    gitDiscard:        (r,f) => call("gitDiscard", r, f),
    gitCommit:         (r,m,a) => call("gitCommit", r, m, a),
    gitPush:           (r,u) => call("gitPush", r, u),
    gitConflictedFile: (r,f) => call("gitConflictedFile", r, f),
    gitWriteResolved:  (r,f,c) => call("gitWriteResolved", r, f, c),
    worktreeList:      (r) => call("worktreeList", r),
    worktreeCreate:    (r,o) => call("worktreeCreate", r, o),
    worktreeRemove:    (r,p,f) => call("worktreeRemove", r, p, f),
    worktreePrune:     (r) => call("worktreePrune", r),
    ptySpawn:          (o) => call("ptySpawn", o),
    ptyWrite:          notify("ptyWrite"),
    ptyResize:         notify("ptyResize"),
    ptyKill:           notify("ptyKill"),
    onPtyData:         (tileId, cb) => subscribe(ptyEvents, tileId + ":data", cb),
    onPtyExit:         (tileId, cb) => subscribe(ptyEvents, tileId + ":exit", cb),
    onFsChanged:       (repoPath, cb) => subscribe(fsEvents, repoPath, cb),
  };
  console.info("[hivemind] dev-bridge installed at " + BRIDGE);
})();
`;

const RPC: Record<string, (...args: unknown[]) => Promise<unknown> | unknown> = {
  resolveProject: async (rootHint?: string) => {
    const cwd = rootHint ? path.resolve(String(rootHint)) : REPO_PATH;
    const root = await findRoot(cwd);
    return { root, cwd };
  },
  listIssues: (root: string) => listIssues(root),
  readIssue: (root: string, id: string) => readIssue(root, id),
  listCycles: (root: string) => listCycles(root),
  updateIssueState: async (root: string, id: string, state: IssueState, note?: string) => {
    const issue = await readIssue(root, id);
    appendActivity(issue, "ui", `state ${issue.state} → ${state}${note ? ` · ${note}` : ""}`);
    issue.state = state;
    await writeIssue(issue);
    await writeAgentContext(root);
    return issue;
  },
  createIssue: async (root: string, opts: Parameters<typeof createIssue>[1]) => {
    const issue = await createIssue(root, opts);
    await writeAgentContext(root);
    return issue;
  },
  updateIssue: async (root: string, id: string, patch: IssuePatch) => {
    const issue = await updateIssue(root, id, patch, "ui");
    await writeAgentContext(root);
    return issue;
  },
  commentOnIssue: async (root: string, id: string, message: string) => {
    const issue = await commentOnIssue(root, id, message, "ui");
    await writeAgentContext(root);
    return issue;
  },
  deleteIssue: async (root: string, id: string) => {
    await deleteIssueCore(root, id);
    await writeAgentContext(root);
    return null;
  },
  gitStatus: (r: string) => gitStatus(r),
  gitListFiles: (r: string) => gitListFiles(r),
  gitDiff: (r: string, s: Parameters<typeof gitDiff>[1], f?: string) => gitDiff(r, s, f),
  gitFileContents: (r: string, f: string, v: "HEAD" | "INDEX" | "WORKING") =>
    gitFileContents(r, f, v),
  gitStage: (r: string, f: string[]) => gitStage(r, f),
  gitUnstage: (r: string, f: string[]) => gitUnstage(r, f),
  gitDiscard: (r: string, f: string[]) => gitDiscard(r, f),
  gitCommit: (r: string, m: string, a?: boolean) => gitCommit(r, m, a),
  gitPush: (r: string, u?: boolean) => gitPush(r, u),
  gitConflictedFile: (r: string, f: string) => gitConflictedFile(r, f),
  gitWriteResolved: (r: string, f: string, c: string) => gitWriteResolved(r, f, c),
  worktreeList: (r: string) => worktreeList(r),
  worktreeCreate: (r: string, o: Parameters<typeof worktreeCreate>[1]) => worktreeCreate(r, o),
  worktreeRemove: (r: string, p: string, f?: boolean) => worktreeRemove(r, p, f),
  worktreePrune: (r: string) => worktreePrune(r),
  ptySpawn: async (opts: Parameters<typeof spawnPty>[0]) => {
    if (!ptySpawnAllowed()) {
      throw new Error(
        `ptySpawn rate limit: ${PTY_SPAWN_LIMIT} spawns / ${PTY_SPAWN_WINDOW_MS / 1000}s exceeded`,
      );
    }
    return spawnPty(opts, {
      onData: (data) => {
        for (const stream of ptyStreams)
          sse(stream, "message", { tileId: opts.tileId, kind: "data", payload: data });
      },
      onExit: (code, signal) => {
        for (const stream of ptyStreams)
          sse(stream, "message", { tileId: opts.tileId, kind: "exit", payload: { code, signal } });
      },
    });
  },
};

const NOTIFY: Record<string, (...args: unknown[]) => void> = {
  ptyWrite: (tileId: string, data: string) => writePty(tileId, data),
  ptyResize: (tileId: string, cols: number, rows: number) => resizePty(tileId, cols, rows),
  ptyKill: (tileId: string) => killPty(tileId),
};

/** Constant-time equality to avoid token-leak via timing. */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkToken(req: http.IncomingMessage): boolean {
  const t = req.headers["x-hive-token"];
  return typeof t === "string" && timingSafeEq(t, AUTH_TOKEN);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS — locked to loopback origins only. Was `*` (REVIEW.md CR-01: any
  // page could POST to localhost:5180/rpc/ptySpawn and run arbitrary commands).
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-hive-token");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // One-time auth token fetch (loopback-only by virtue of HOST binding).
  if (url.pathname === "/auth-token" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: AUTH_TOKEN }));
    return;
  }

  // Static renderer + dev-bridge preload script.
  if (url.pathname === "/hive-bridge.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(PREVIEW_SCRIPT);
    return;
  }
  if (req.method === "GET" && !url.pathname.startsWith("/rpc/") && !url.pathname.startsWith("/notify/") && !url.pathname.startsWith("/events/")) {
    return serveStatic(url, res);
  }

  // SSE: pty events.
  if (url.pathname === "/events/pty") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    ptyStreams.add(res);
    req.on("close", () => ptyStreams.delete(res));
    return;
  }
  // SSE: fs events.
  if (url.pathname === "/events/fs") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    fsStreams.add(res);
    req.on("close", () => fsStreams.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/rpc/")) {
    const method = url.pathname.slice(5);
    const fn = RPC[method];
    if (!fn) {
      res.writeHead(404).end(`unknown RPC method: ${method}`);
      return;
    }
    if (PROTECTED_METHODS.has(method) && !checkToken(req)) {
      res.writeHead(401).end("unauthorized: x-hive-token missing or wrong");
      return;
    }
    const body = await readBody(req);
    try {
      const args = JSON.parse(body) as unknown[];
      const result = await fn(...args);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result ?? null));
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`${(e as Error).message}\n${(e as Error).stack ?? ""}`);
    }
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/notify/")) {
    const method = url.pathname.slice(8);
    const fn = NOTIFY[method];
    if (!fn) {
      res.writeHead(404).end(`unknown notify method: ${method}`);
      return;
    }
    if (PROTECTED_METHODS.has(method) && !checkToken(req)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const body = await readBody(req);
    try {
      const args = JSON.parse(body) as unknown[];
      fn(...args);
      res.writeHead(204).end();
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
    return;
  }

  res.writeHead(404).end("not found");
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveStatic(url: URL, res: http.ServerResponse): Promise<void> {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const abs = path.join(RENDERER_DIST, rel);
  // Path traversal guard.
  if (!abs.startsWith(RENDERER_DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body: Buffer | string = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    if (ext === ".html") {
      // Inject our bridge script BEFORE the renderer bundle so window.hive
      // is installed before <App /> mounts.
      body = body
        .toString("utf8")
        .replace("</head>", `  <script src="/hive-bridge.js"></script>\n</head>`);
    }
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end(`not found: ${rel}`);
  }
}

// chokidar watcher that forwards fs:changed events to /events/fs subscribers.
const watcher = chokidar.watch(
  [
    path.join(REPO_PATH, ".git", "HEAD"),
    path.join(REPO_PATH, ".git", "index"),
    path.join(REPO_PATH, ".git", "MERGE_HEAD"),
    path.join(REPO_PATH, ".hivemind"),
    REPO_PATH,
  ],
  {
    ignored: (p: string) =>
      p.includes("/node_modules/") ||
      p.includes("/.git/objects/") ||
      p.includes("/.git/logs/") ||
      p.includes("/dist/") ||
      p.includes("/out/") ||
      p.includes("/.turbo/"),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  }
);
let pending = new Set<string>();
let flush: NodeJS.Timeout | null = null;
const triggerFs = (p: string) => {
  pending.add(p);
  if (flush) clearTimeout(flush);
  flush = setTimeout(() => {
    const paths = Array.from(pending);
    pending = new Set();
    flush = null;
    for (const s of fsStreams) sse(s, "message", { repoPath: REPO_PATH, payload: { paths } });
  }, 300);
};
watcher.on("add", triggerFs).on("change", triggerFs).on("unlink", triggerFs);

// Patch PATH from the user's login shell (matches main process behavior so
// pty.spawn("claude") works the same whether launched via Electron or HTTP).
void applyShellEnvToProcess();

const server = http.createServer(handle);
// Bind to loopback ONLY — never expose dev-bridge to the LAN. Combined with
// the per-process AUTH_TOKEN, this means: (a) external machines can't reach
// us, (b) other apps on the same machine can't drive the API without first
// reading the token from us, which requires same-origin access.
server.listen(PORT, HOST, () => {
  console.log(`hivemind dev-bridge listening on http://${HOST}:${PORT}/`);
  console.log(`  repo: ${REPO_PATH}`);
  console.log(`  serving renderer from: ${RENDERER_DIST}`);
  console.log(`  auth-token: ${AUTH_TOKEN.slice(0, 8)}…${AUTH_TOKEN.slice(-4)}`);
});

process.on("SIGINT", () => {
  console.log("\nshutting down dev-bridge");
  void watcher.close();
  server.close();
  process.exit(0);
});
