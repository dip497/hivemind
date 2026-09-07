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
import { pathToFileURL } from "node:url";
import { listInstalledViews, type InstalledView } from "@hivemind/core/views";
import { ENTRY_PAGE, VIEW_SCHEME, entryPage, entryUrl, mimeFor, newNonce, pluginCsp, resolvePackageFile } from "./view-package-files.js";

export { VIEW_SCHEME, entryUrl } from "./view-package-files.js";

export interface ViewPackageInfo extends InstalledView {
  /** Where the iframe loads from (null when the package will not load). */
  url: string | null;
}

/** id → package dir of every loadable package from the last scan. Only these are served. */
const served = new Map<string, string>();

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
      const nonce = newNonce();
      const headers = { "Content-Security-Policy": pluginCsp(nonce), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
      if (rel === ENTRY_PAGE) {
        const html = entryPage(u.searchParams.get("js") ?? "", nonce);
        if (!html) return new Response("bad entry", { status: 400 });
        return new Response(html, { status: 200, headers: { ...headers, "Content-Type": mimeFor(".html") } });
      }
      const file = resolvePackageFile(dir, rel);
      if (file.status !== 200) return new Response(file.status === 403 ? "forbidden" : "not found", { status: file.status });
      const res = await net.fetch(pathToFileURL(file.abs).toString(), { headers: request.headers });
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) out.set(k, v);
      out.set("Content-Type", mimeFor(file.abs));
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
