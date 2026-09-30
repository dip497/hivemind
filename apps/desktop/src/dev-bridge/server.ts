/**
 * Dev HTTP bridge — exposes the SAME main-process adapters (hive-core,
 * the workspace API's server, pty-host) over HTTP so the renderer can be
 * driven by /gsd-browser without packaging Electron.
 *
 * Nothing here is mocked. The handlers import the same files Electron
 * loads in production; the only difference is the transport (HTTP/SSE
 * instead of Electron IPC). The workspace API (git and worktrees, files,
 * issues, review comments) is the same server main answers with, at
 * POST /workspace.
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
import { findRoot } from "@hivemind/core";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../main/workspace/domains";
import { agents } from "../main/workspace/agents";
import { spawnPty, writePty, resizePty, killPty, pausePty, resumePty, detachPty } from "../main/pty-host";
import { Terminals } from "../main/workspace/terminals";
import { watchRepo } from "../main/fs-watcher";
import { applyShellEnvToProcess } from "@hivemind/agent-host/shell-env";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { randomBytes } from "node:crypto";
import * as os from "node:os";

const REPO_PATH = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const PORT = Number(process.env.HIVE_BRIDGE_PORT ?? 5180);
const HOST = "127.0.0.1"; // Linux: loopback only — never expose to LAN.
const RENDERER_DIST = path.resolve(__dirname, "..", "..", "out", "renderer");

// Per-process auth token printed on startup. Renderer's preload.js fetches
// `/auth-token` (LOCAL only — same-origin) once and includes it on every
// call. Defeats CSRF-style "any local origin can spawn arbitrary processes"
// attacks (REVIEW.md CR-01).
const AUTH_TOKEN = randomBytes(32).toString("hex");

// The workspace API (R8): the same server main answers the app's windows with, as the person at
// this machine, and recorded in the dev app's audit log. A page connects by opening its event
// stream (GET /workspace/events), which names its connection; its calls and notices name that
// connection. Every one needs the token. No control plane runs here, so no agent has a status.
const intents = new Intents(new AuditLog({
  file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hivemind-dev", "audit.jsonl"),
  onWarn: (m) => console.warn(`[audit] ${m}`),
}));
// Terminals run in this process (no daemon): one a page lets go of ends.
const terminals = new Terminals({
  intents,
  relay: { record: () => {}, screenPrefix: "\x1bc" },
  onError: (m) => console.warn(`[terminals] ${m}`),
  backend: {
    start: async (opts, out) => {
      if (!ptySpawnAllowed()) throw new Error(`terminal rate limit: ${PTY_SPAWN_LIMIT} starts / ${PTY_SPAWN_WINDOW_MS / 1000}s exceeded`);
      return spawnPty(opts, { onData: (data) => out.data(data), onExit: (code, signal) => out.exit(code, signal) });
    },
    write: writePty,
    echoes: () => true,
    resize: resizePty,
    pause: pausePty,
    resume: resumePty,
    kill: killPty,
    detach: detachPty,
    screen: () => null,
  },
});
const workspaceServer = new WorkspaceServer([
  ...workspaceDomains,
  agents({ statuses: () => [], links: () => ({ pipes: [], spawns: [] }) }),
  terminals.domain,
], intents, (m) => console.warn(`[workspace] ${m}`));
/** Each page's connection, by the id its event stream was given. */
const workspaceConnections = new Map<string, Connection>();

// ── terminal start rate limit ───────────────────────────────────
// Defense in depth: even with AUTH_TOKEN + loopback-only binding, a
// misbehaving same-origin script could start terminals in a loop and fork-bomb
// the host. 20 starts / 60s window is generous for any human-driven UI but
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
  // The workspace API: this page's connection is its event stream, which names it; a call's
  // answer is a result or an error with a code; a notice is answered with nothing.
  const workspaceListeners = {};
  const connection = tokenP.then((token) => new Promise((resolve) => {
    const es = new EventSource(BRIDGE + "/workspace/events?token=" + encodeURIComponent(token));
    es.addEventListener("connection", (ev) => resolve(JSON.parse(ev.data).id));
    es.onmessage = (ev) => {
      const { event, params } = JSON.parse(ev.data);
      for (const cb of workspaceListeners[event] || []) {
        try { cb(...params); } catch (e) { console.error("[workspace] a listener for " + event + " failed:", e); }
      }
    };
  }));
  async function workspaceHeaders() {
    return { ...(await authHeaders()), "x-hive-connection": await connection };
  }
  async function api(method, ...params) {
    const r = await fetch(BRIDGE + "/workspace", {
      method: "POST",
      headers: await workspaceHeaders(),
      body: JSON.stringify({ method, params }),
    });
    if (!r.ok) throw new Error(await r.text());
    const answer = await r.json();
    if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.result;
  }
  function apiNotice(method, ...params) {
    workspaceHeaders().then((headers) => fetch(BRIDGE + "/workspace/notice", {
      method: "POST",
      headers,
      body: JSON.stringify({ method, params }),
    })).catch((e) => console.error("[workspace] " + method + ":", e));
  }
  function onEvent(event, cb) {
    return subscribe(workspaceListeners, event, cb);
  }
  function subscribe(map, key, cb) {
    if (!map[key]) map[key] = [];
    map[key].push(cb);
    return () => { map[key] = map[key].filter(x => x !== cb); };
  }
  window.hive = {
    resolveProject:    (h) => call("resolveProject", h),
    listIssues:        (r) => api("issue.list", r),
    readIssue:         (r,i) => api("issue.read", r, i),
    updateIssueState:  (r,i,s,n) => api("issue.setState", r, i, s, n),
    createIssue:       (r,o) => api("issue.create", r, o),
    updateIssue:       (r,i,p) => api("issue.update", r, i, p),
    commentOnIssue:    (r,i,m) => api("issue.comment", r, i, m),
    deleteIssue:       (r,i) => api("issue.delete", r, i),
    linkIssue:         (r,i,o,t) => api("issue.link", r, i, o, t),
    unlinkIssue:       (r,i,o) => api("issue.unlink", r, i, o),
    moveIssue:         (r,i,p,m) => api("issue.move", r, i, p, m),
    reviewList:        (r) => api("review.list", r),
    reviewSave:        (r,c) => api("review.save", r, c),
    fileRead:          (r,f) => api("file.read", r, f),
    fileWrite:         (r,f,c) => api("file.write", r, f, c),
    hcpStatusAll:      () => api("status.all"),
    hcpLinks:          () => api("link.list"),
    onHcpStatus:       (cb) => onEvent("status.changed", cb),
    onHcpPipe:         (cb) => onEvent("link.pipe", cb),
    onHcpSpawn:        (cb) => onEvent("link.spawn", cb),
    onHcpSpawned:      (cb) => onEvent("tile.opened", cb),
    gitStatus:         (r) => api("git.status", r),
    gitListFiles:      (r) => api("git.listFiles", r),
    gitListBranches:   (r) => api("git.listBranches", r),
    gitDiff:           (r,s,f) => api("git.diff", r, s, f),
    gitFileContents:   (r,f,v) => api("git.fileContents", r, f, v),
    gitStage:          (r,f) => api("git.stage", r, f),
    gitUnstage:        (r,f) => api("git.unstage", r, f),
    gitDiscard:        (r,f) => api("git.discard", r, f),
    gitCommit:         (r,m,a) => api("git.commit", r, m, a),
    gitPush:           (r,u) => api("git.push", r, u),
    gitPull:           (r) => api("git.pull", r),
    gitConflictedFile: (r,f) => api("git.conflictedFile", r, f),
    gitWriteResolved:  (r,f,c) => api("git.writeResolved", r, f, c),
    worktreeList:      (r) => api("worktree.list", r),
    worktreeCreate:    (r,o) => api("worktree.create", r, o),
    worktreeRemove:    (r,p,f) => api("worktree.remove", r, p, f),
    worktreePrune:     (r) => api("worktree.prune", r),
    ptySpawn:          (o) => api("terminal.open", o),
    ptyWrite:          (t,d,p) => apiNotice("terminal.write", t, d, p),
    ptyInterest:       (t,s) => apiNotice("terminal.show", t, s),
    ptyResize:         (t,c,r) => apiNotice("terminal.resize", t, c, r),
    ptyKill:           (t) => apiNotice("terminal.close", t),
    ptyDetach:         (t) => apiNotice("terminal.detach", t),
    ptyFlow:           (t,p) => apiNotice("terminal.flow", t, p),
    ptyActivityWatch:  (ts) => apiNotice("terminal.watchActivity", ts),
    onPtyActivity:     (cb) => onEvent("terminal.activity", cb),
    onPtyData:         (tile, cb) => onEvent("terminal.data", (t, d) => { if (t === tile) cb(d); }),
    onPtyExit:         (tile, cb) => onEvent("terminal.exit", (t, e) => { if (t === tile) cb(e); }),
    onFsChanged:       (repo, cb) => onEvent("file.changed", (r, c) => { if (r === repo) cb(c); }),
  };
  console.info("[hivemind] dev-bridge installed at " + BRIDGE);
})();
`;

const RPC: Record<string, (...args: unknown[]) => Promise<unknown> | unknown> = {
  resolveProject: async (rootHint?: unknown) => {
    const cwd = typeof rootHint === "string" && rootHint ? path.resolve(rootHint) : REPO_PATH;
    const root = await findRoot(cwd);
    return { root, cwd };
  },
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
  if (req.method === "GET" && !url.pathname.startsWith("/rpc/") && !url.pathname.startsWith("/workspace/")) {
    return serveStatic(url, res);
  }

  if (req.method === "GET" && url.pathname === "/workspace/events") {
    const token = url.searchParams.get("token");
    if (!token || !timingSafeEq(token, AUTH_TOKEN)) {
      res.writeHead(401).end("unauthorized: token missing or wrong");
      return;
    }
    const id = randomBytes(16).toString("hex");
    const gone = new AbortController();
    const connection: Connection = {
      actor: { kind: "person" },
      send: (message) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); },
      closed: gone.signal,
    };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: connection\ndata: ${JSON.stringify({ id })}\n\n`);
    workspaceConnections.set(id, connection);
    workspaceServer.connect(connection);
    watchRepo(REPO_PATH, connection);
    req.on("close", () => { workspaceConnections.delete(id); gone.abort(); });
    return;
  }
  if (req.method === "POST" && (url.pathname === "/workspace" || url.pathname === "/workspace/notice")) {
    if (!checkToken(req)) {
      res.writeHead(401).end("unauthorized: x-hive-token missing or wrong");
      return;
    }
    const from = workspaceConnections.get(String(req.headers["x-hive-connection"]));
    if (!from) {
      res.writeHead(400).end("no connection: open GET /workspace/events and name it in x-hive-connection");
      return;
    }
    let call: { method?: unknown; params?: unknown };
    try {
      call = JSON.parse(await readBody(req)) ?? {};
    } catch {
      res.writeHead(400).end("a call is JSON: { method, params }");
      return;
    }
    if (url.pathname === "/workspace/notice") {
      workspaceServer.notice(call.method, call.params, from);
      res.writeHead(204).end();
      return;
    }
    const answer = await workspaceServer.answer(call.method, call.params, from);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/rpc/")) {
    const method = url.pathname.slice(5);
    const fn = RPC[method];
    if (!fn) {
      res.writeHead(404).end(`unknown RPC method: ${method}`);
      return;
    }
    if (!checkToken(req)) {
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
  server.close();
  process.exit(0);
});
