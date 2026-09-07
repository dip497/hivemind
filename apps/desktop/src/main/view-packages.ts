/**
 * Community view packages, main-process side: list them for the renderer and
 * serve their files to the sandboxed iframe over `hm-view://<id>/<path>`.
 *
 * Why a custom scheme and not file://: the app page itself is file:// in
 * production, so a file:// iframe would be same-origin with the privileged
 * renderer unless sandboxed — and a scheme of its own (a) gives every plugin
 * a distinct origin `hm-view://<id>` even before the sandbox makes it opaque,
 * (b) lets the renderer CSP allow exactly `frame-src hm-view:` and nothing
 * else, (c) confines reads to the package dirs listed by the LAST scan (never
 * an arbitrary path from a URL), and (d) lets us stamp a strict CSP on every
 * response so plugin code cannot reach the network or embed anything.
 */
import { app, net, protocol, type BrowserWindow, type WebFrameMain } from "electron";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { listInstalledViews, type InstalledView } from "@hivemind/core/views";

export const VIEW_SCHEME = "hm-view";

export interface ViewPackageInfo extends InstalledView {
  /** Where the iframe loads from (null when the package will not load). */
  url: string | null;
}

/** id → package dir of every loadable package from the last scan. Only these are served. */
const served = new Map<string, string>();

/** The CSP every plugin document gets. No network (connect-src 'none'), no
 *  frames, no forms, nothing from any other scheme; inline script/style are
 *  allowed because a bundled single-file plugin is exactly that. */
export const PLUGIN_CSP = [
  "default-src 'none'",
  `script-src ${VIEW_SCHEME}: 'unsafe-inline' 'wasm-unsafe-eval'`,
  `style-src ${VIEW_SCHEME}: 'unsafe-inline'`,
  `img-src ${VIEW_SCHEME}: data: blob:`,
  `font-src ${VIEW_SCHEME}: data:`,
  `media-src ${VIEW_SCHEME}: data: blob:`,
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".txt": "text/plain; charset=utf-8",
};

/** Scan both roots; remember the loadable ones for the protocol handler. */
export async function listViewPackages(repoRoot: string | null): Promise<ViewPackageInfo[]> {
  const views = await listInstalledViews(repoRoot);
  served.clear();
  return views.map((v) => {
    if (v.error || !v.manifest) return { ...v, url: null };
    served.set(v.id, v.dir);
    return { ...v, url: entryUrl(v.id, v.manifest.entry) };
  });
}

/** A `.html` entry is loaded as-is; a `.js` entry through a generated page. */
export function entryUrl(id: string, entry: string): string {
  return entry.endsWith(".js") ? `${VIEW_SCHEME}://${id}/__entry.html?js=${encodeURIComponent(entry)}` : `${VIEW_SCHEME}://${id}/${entry}`;
}

/** Call BEFORE app ready. */
export function registerViewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
  ]);
}

/** Call after app ready. */
export function handleViewProtocol(): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      const dir = served.get(u.host);
      if (!dir) return new Response("unknown view", { status: 404 });
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      const headers = { "Content-Security-Policy": PLUGIN_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
      if (rel === "__entry.html") {
        const js = u.searchParams.get("js") ?? "";
        if (!/^[\w./-]+\.js$/.test(js) || js.split("/").includes("..")) return new Response("bad entry", { status: 400 });
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style></head><body><script type="module" src="./${js}"></script></body></html>`;
        return new Response(html, { status: 200, headers: { ...headers, "Content-Type": MIME[".html"]! } });
      }
      const abs = path.resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + path.sep)) return new Response("forbidden", { status: 403 });
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response("not found", { status: 404 });
      const res = await net.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) out.set(k, v);
      out.set("Content-Type", MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
      return new Response(res.body, { status: res.status, headers: out });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  });
}

// ── runaway watchdog ────────────────────────────────────────────────────────
// A sandboxed hm-view iframe is an out-of-process frame (measured: its own
// renderer pid), so a busy loop in it cannot stall the host's main thread —
// but it can still peg a core. Sample every plugin frame's process CPU; a
// frame over RUNAWAY_CPU_PCT for RUNAWAY_SAMPLES consecutive samples is
// reported to the renderer, which disables the view for the session.
// `HIVEMIND_VIEW_RUNAWAY_CPU` overrides the threshold (the e2e suite lowers it:
// under xvfb on a loaded machine a spinning frame is descheduled so hard that
// its CPU share reads single digits).
export const RUNAWAY_CPU_PCT = Number(process.env.HIVEMIND_VIEW_RUNAWAY_CPU) || 60;
export const RUNAWAY_SAMPLES = 3;
export const WATCHDOG_INTERVAL_MS = 2000;

export interface ViewRunawayEvent { id: string; cpuPct: number }

export function startViewWatchdog(win: BrowserWindow): () => void {
  const strikes = new Map<string, number>();
  const timer = setInterval(() => {
    if (win.isDestroyed()) return;
    let frames: WebFrameMain[];
    try { frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f.url.startsWith(`${VIEW_SCHEME}://`)); } catch { return; }
    if (frames.length === 0) { strikes.clear(); return; }
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m.cpu.percentCPUUsage]));
    const seen = new Set<string>();
    for (const f of frames) {
      let id = "";
      try { id = new URL(f.url).host; } catch { continue; }
      seen.add(id);
      const cpu = byPid.get(f.osProcessId) ?? 0;
      const n = cpu >= RUNAWAY_CPU_PCT ? (strikes.get(id) ?? 0) + 1 : 0;
      strikes.set(id, n);
      if (n >= RUNAWAY_SAMPLES) {
        strikes.set(id, 0);
        const ev: ViewRunawayEvent = { id, cpuPct: Math.round(cpu) };
        win.webContents.send("views:runaway", ev);
      }
    }
    for (const id of strikes.keys()) if (!seen.has(id)) strikes.delete(id);
  }, WATCHDOG_INTERVAL_MS);
  return () => clearInterval(timer);
}
