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
import { dialogStart, rememberPick } from "./dialog-start";
import { app, net, protocol, dialog, type BrowserWindow, type WebFrameMain } from "electron";
import { handle, handleEffect } from "./app-ipc.js";
import { appWindowOf } from "./windows.js";
import { pathToFileURL } from "node:url";
import { listInstalledViews, readViewPackage, installView, removeView, type InstalledView } from "@hivemind/core/views";
import { VIEW_SCHEME, entryUrl, newNonce, serveViewFile } from "@hivemind/core/view-files";
import { viewHost } from "@hivemind/view-sdk/manifest";
import type { ViewFile, ViewListing } from "@hivemind/workspace-api/views";
import { elsewhere } from "./shared-workspaces.js";

export { VIEW_SCHEME, entryUrl } from "@hivemind/core/view-files";

export interface ViewPackageInfo extends Omit<InstalledView, "source"> {
  source: InstalledView["source"] | "host";
  /** Where the iframe loads from (null when the package will not load). */
  url: string | null;
}

async function remoteCall<T>(method: string, params: unknown[]): Promise<T> {
  const answer = await elsewhere.call(method, params);
  if (!answer || "error" in answer) throw new Error(answer && "error" in answer ? answer.error.message : "host unavailable");
  return answer.result as T;
}

/** Origin host → the package behind it, from the last scan. Only these are served. The host is
 *  not always the id (`@owner/name` is served as `owner--name`), so the id travels with it. */
const served = new Map<string, { id: string; dir?: string; repo?: string }>();

/** Scan both roots; remember the loadable ones for the protocol handler. */
export async function listViewPackages(repoRoot: string | null): Promise<ViewPackageInfo[]> {
  const remote = repoRoot?.startsWith("hive://") ? repoRoot : null;
  const views = await listInstalledViews(remote ? null : repoRoot);
  served.clear();
  const hosted: ViewPackageInfo[] = [];
  if (remote) {
    try {
      const listed = await remoteCall<ViewListing[]>("view.list", [remote, "desktop"]);
      for (const v of listed) {
        if (!v.manifest) continue;
        const page = new URL(entryUrl(v.id, v.entry));
        page.searchParams.set("workspace", remote);
        const url = page.toString();
        served.set(viewHost(v.id), { id: v.id, repo: remote });
        hosted.push({ id: v.id, dir: "", source: "host", manifest: v.manifest, error: null, url });
      }
    } catch { /* a disconnected host leaves the built-in and local views available */ }
  }
  const local = await Promise.all(views.filter((v) => !hosted.some((h) => h.id === v.id)).map(async (v) => {
    if (v.error || !v.manifest) return { ...v, url: null };
    served.set(viewHost(v.id), { id: v.id, dir: v.dir });
    const entry = await stat(path.join(v.dir, v.manifest.entry)).catch(() => null);
    const revision = entry ? `${entry.mtimeMs}-${entry.ctimeMs}-${entry.size}` : "missing";
    const url = new URL(entryUrl(v.id, v.manifest.entry));
    url.searchParams.set("revision", revision);
    return { ...v, url: url.toString() };
  }));
  return [...hosted, ...local];
}


/** Call BEFORE app ready. */
export function registerViewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled: a view's page is sandboxed to an opaque origin, and loading a module
    // script is always a CORS request — so without it Chromium refuses the view's own code
    // and it never starts. The boundary is the sandbox + CSP (connect-src 'none'), not this.
    { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

let sdk: string | undefined;

/** The view SDK this app serves every view (`__sdk.js`), in its windows and on the person's phone:
 *  its own build, beside main. */
export async function viewSdk(): Promise<string> {
  return (sdk ??= await readFile(new URL("./view-sdk.js", import.meta.url), "utf8"));
}

/** Call after app ready. */
export function handleViewProtocol(): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      const source = served.get(u.host);
      if (!source) return new Response("unknown view", { status: 404 });
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      if (source.repo) {
        const file = await remoteCall<ViewFile>("view.file", [source.id, rel, source.repo]);
        return new Response(Buffer.from(file.data, "base64"), { status: 200, headers: {
          "Content-Security-Policy": file.csp, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*", "Content-Type": file.type,
        } });
      }
      const dir = source.dir;
      if (!dir) return new Response("unknown view", { status: 404 });
      const file = await serveViewFile(dir, rel, { js: u.searchParams.get("js"), sdk: viewSdk });
      if (file.status !== 200) return new Response(file.status === 400 ? "bad entry" : file.status === 403 ? "forbidden" : "not found", { status: file.status });
      // The files are the view's published code; who may run them is the CSP's call.
      const headers = { "Content-Security-Policy": file.csp, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
      if ("text" in file) return new Response(file.text, { status: 200, headers: { ...headers, "Content-Type": file.type } });
      const res = await net.fetch(pathToFileURL(file.file).toString(), { headers: request.headers });
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) out.set(k, v);
      out.set("Content-Type", file.type);
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
let pending: { token: string; dir: string; id: string; manifest: string; staged: boolean } | null = null;

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
  pending = { token, dir: pkg.dir, id: pkg.id, manifest: JSON.stringify(pkg.manifest), staged };
  return { token, package: { ...pkg, url: null }, replacesVersion: existing ? existing.manifest?.version ?? "unknown" : null };
}

/** The renderer can install only a package it was shown for review. */
export function installViewManagementIpc(): void {
  handle("views:preview-install", async (event) => {
    const win = appWindowOf(event.sender)!; // the gate answers app windows only
    if (pending?.staged) await rm(pending.dir, { recursive: true, force: true }).catch(() => {});
    pending = null;
    const result = await dialog.showOpenDialog(win, { title: "Choose a view extension", buttonLabel: "Review extension", defaultPath: dialogStart("view", app.getPath("home")), properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    rememberPick("view", result.filePaths[0]);
    return reviewViewDir(result.filePaths[0], false);
  });
  handleEffect("views:install", (token) => ({ target: pending && token === pending.token ? pending.id : undefined }), async (_event, token: string) => {
    if (!pending || token !== pending.token) throw new Error("Choose the extension folder again");
    const candidate = pending;
    pending = null;
    try {
      const pkg = await readViewPackage(candidate.dir, "user", false);
      if (pkg.error || JSON.stringify(pkg.manifest) !== candidate.manifest) throw new Error("The extension changed. Choose its folder again to review it.");
      await installView(candidate.dir);
    } finally { if (candidate.staged) await rm(candidate.dir, { recursive: true, force: true }).catch(() => {}); }
  });
  handleEffect("views:remove", (id) => ({ target: typeof id === "string" ? id : undefined }), async (_event, id: string) => {
    if (typeof id !== "string") throw new Error("Invalid extension ID");
    await removeView(id);
  });
}
