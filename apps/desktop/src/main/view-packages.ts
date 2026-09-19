import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
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
import { app, net, protocol, dialog, ipcMain, type BrowserWindow, type WebFrameMain } from "electron";
import { pathToFileURL } from "node:url";
import { listInstalledViews, readViewPackage, installView, removeView, type InstalledView } from "@hivemind/core/views";
import { ENTRY_PAGE, SDK_PATH, VIEW_SCHEME, entryPage, entryUrl, withImportMap, mimeFor, newNonce, pluginCsp, resolvePackageFile } from "./view-package-files.js";
import { viewHost } from "@hivemind/view-sdk/manifest";

export { VIEW_SCHEME, entryUrl } from "./view-package-files.js";

export interface ViewPackageInfo extends InstalledView {
  /** Where the iframe loads from (null when the package will not load). */
  url: string | null;
}

/** Origin host → the package behind it, from the last scan. Only these are served. The host is
 *  not always the id (`@owner/name` is served as `owner--name`), so the id travels with it. */
const served = new Map<string, { id: string; dir: string }>();

/** Scan both roots; remember the loadable ones for the protocol handler. */
export async function listViewPackages(repoRoot: string | null): Promise<ViewPackageInfo[]> {
  const views = await listInstalledViews(repoRoot);
  served.clear();
  return Promise.all(views.map(async (v) => {
    if (v.error || !v.manifest) return { ...v, url: null };
    served.set(viewHost(v.id), { id: v.id, dir: v.dir });
    const entry = await stat(path.join(v.dir, v.manifest.entry)).catch(() => null);
    const revision = entry ? `${entry.mtimeMs}-${entry.ctimeMs}-${entry.size}` : "missing";
    const url = new URL(entryUrl(v.id, v.manifest.entry));
    url.searchParams.set("revision", revision);
    return { ...v, url: url.toString() };
  }));
}


/** Call BEFORE app ready. */
export function registerViewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
  ]);
}

let sdk: string | undefined;

/** Call after app ready. */
export function handleViewProtocol(): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      const dir = served.get(u.host)?.dir;
      if (!dir) return new Response("unknown view", { status: 404 });
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      const nonce = newNonce();
      const headers = { "Content-Security-Policy": pluginCsp(nonce), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
      if (rel === ENTRY_PAGE) {
        const html = entryPage(u.searchParams.get("js") ?? "", nonce);
        if (!html) return new Response("bad entry", { status: 400 });
        return new Response(withImportMap(html, nonce), { status: 200, headers: { ...headers, "Content-Type": mimeFor(ENTRY_PAGE) } });
      }
      if (rel === SDK_PATH) {
        sdk ??= await readFile(new URL("./view-sdk.js", import.meta.url), "utf8");
        return new Response(sdk, { status: 200, headers: { ...headers, "Content-Type": mimeFor(SDK_PATH) } });
      }
      const file = resolvePackageFile(dir, rel);
      if (file.status !== 200) return new Response(file.status === 403 ? "forbidden" : "not found", { status: file.status });
      if (/\.html?$/i.test(file.abs)) {
        const html = withImportMap(await readFile(file.abs, "utf8"), nonce);
        return new Response(html, { status: 200, headers: { ...headers, "Content-Type": mimeFor(ENTRY_PAGE) } });
      }
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
      // The frame knows its host; the registry knows ids. Report the id or nothing is disabled.
      try { const host = new URL(f.url).host; id = served.get(host)?.id ?? host; } catch { continue; }
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

/** The one package under review. Re-read before installing, so changed permissions need review again. */
let pending: { token: string; dir: string; manifest: string; staged: boolean } | null = null;

/** Review a view folder: the native picker's choice, or a verified catalog download (`staged`). */
export async function reviewViewDir(dir: string, staged: boolean) {
  if (pending?.staged) await rm(pending.dir, { recursive: true, force: true }).catch(() => {});
  pending = null;
  const pkg = await readViewPackage(dir, "user", false);
  if (pkg.error) throw new Error(pkg.error);
  // "world" is still reserved though that view is gone: a saved workspace may name it, and
  // a name this app has shipped should not become available to whoever asks for it next.
  if (["canvas", "windows", "world"].includes(pkg.id)) throw new Error("This extension uses a built-in view ID");
  const existing = (await listInstalledViews()).find((view) => view.id === pkg.id);
  const token = newNonce();
  pending = { token, dir: pkg.dir, manifest: JSON.stringify(pkg.manifest), staged };
  return { token, package: { ...pkg, url: null }, replacesVersion: existing ? existing.manifest?.version ?? "unknown" : null };
}

/** The renderer can install only a package it was shown for review. */
export function installViewManagementIpc(getWindow: () => BrowserWindow | null): void {
  const assertSender = (event: Electron.IpcMainInvokeEvent) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Only the workspace can manage extensions");
    return win;
  };
  ipcMain.handle("views:preview-install", async (event) => {
    const win = assertSender(event);
    if (pending?.staged) await rm(pending.dir, { recursive: true, force: true }).catch(() => {});
    pending = null;
    const result = await dialog.showOpenDialog(win, { title: "Choose a view extension", buttonLabel: "Review extension", properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return reviewViewDir(result.filePaths[0], false);
  });
  ipcMain.handle("views:install", async (event, token: string) => {
    assertSender(event);
    if (!pending || token !== pending.token) throw new Error("Choose the extension folder again");
    const candidate = pending;
    pending = null;
    try {
      const pkg = await readViewPackage(candidate.dir, "user", false);
      if (pkg.error || JSON.stringify(pkg.manifest) !== candidate.manifest) throw new Error("The extension changed. Choose its folder again to review it.");
      await installView(candidate.dir);
    } finally { if (candidate.staged) await rm(candidate.dir, { recursive: true, force: true }).catch(() => {}); }
  });
  ipcMain.handle("views:remove", async (event, id: string) => {
    assertSender(event);
    if (typeof id !== "string") throw new Error("Invalid extension ID");
    await removeView(id);
  });
}
