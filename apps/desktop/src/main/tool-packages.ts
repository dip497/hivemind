/**
 * Tool plugins in the app. Their modules are served over `hm-plugin://<owner>--<name>/…` to the
 * app's windows, which import them into themselves; `hm-plugin://host/…` serves the app's own
 * React and parts back to them, so a plugin shares one copy. A plugin switched off, or any
 * plugin in safe mode (`HIVEMIND_SAFE_MODE=1`), is not served at all. The package format and
 * the folder are core's (`@hivemind/core/tool-packages`).
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dialog, net } from "electron";
import { serveScheme } from "./schemes.js";
import { isPluginOn } from "@hivemind/core/plugin-settings";
import { isToolId, toolOfFolder, type ToolPackage } from "@hivemind/core/tool-format";
import { listToolPackages, toolFile } from "@hivemind/core/tool-packages";
import { installPackage, removePlugin } from "@hivemind/core/package-install";
import { handle } from "./app-ipc.js";
import { appWindowOf, broadcast } from "./windows.js";
import { getSettings, reloadSettings } from "./settings-store.js";
import type { ToolRun, ToolRunResult } from "../shared/ipc.js";

export const PLUGIN_SCHEME = "hm-plugin";
/** The tool plugins that come with the app, built beside its main bundle (scripts/build-views.mjs). */
export const appToolsDir = (): string => fileURLToPath(new URL("../tools", import.meta.url));
/** The packages from the last listing, by id: which folder each is served from. */
const listed = new Map<string, ToolPackage>();
export const listTools = async (): Promise<ToolPackage[]> => {
  const packages = await listToolPackages(appToolsDir());
  listed.clear();
  for (const p of packages) if (!listed.has(p.id)) listed.set(p.id, p);
  return packages;
};
export const safeMode = (): boolean => process.env.HIVEMIND_SAFE_MODE === "1";

const TYPES: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2",
};

/** What each host module exports, by name, as the window that loads plugins reported it. */
let hostExports: Record<string, string[]> = {};
const HOST_MODULE = /^\/([a-z-]+)\.js$/;

function hostModule(name: string): string | null {
  const names = hostExports[name];
  if (!names) return null;
  const named = names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default");
  return `const m = globalThis.__hiveHost[${JSON.stringify(name)}];\nexport default m.default ?? m;\n`
    + (named.length ? `export const { ${named.join(", ")} } = m;\n` : "");
}

const served = (body: BodyInit | null, type: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/** Call after app ready. */
export function handleToolProtocol(): void {
  serveScheme(PLUGIN_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      if (u.host === "host") {
        const m = HOST_MODULE.exec(u.pathname);
        const code = m ? hostModule(m[1]!) : null;
        return code ? served(code, "text/javascript") : served("no such host module", "text/plain", 404);
      }
      const id = toolOfFolder(u.host);
      const pkg = isToolId(id) ? listed.get(id) ?? (await listTools()).find((p) => p.id === id) : undefined;
      const app = pkg?.source === "app";
      if (!pkg || (safeMode() && !app) || !isPluginOn(getSettings().plugins.state, "tool", pkg, app)) return served("not switched on", "text/plain", 404);
      const file = toolFile(pkg.dir, decodeURIComponent(u.pathname.replace(/^\/+/, "")));
      const type = file ? TYPES[path.extname(file).toLowerCase()] : undefined;
      if (!file || !type) return served("not served", "text/plain", 403);
      const res = await net.fetch(pathToFileURL(file).toString());
      return served(res.body, type, res.status);
    } catch {
      return served("bad request", "text/plain", 400);
    }
  });
}

const toolListeners = new Set<() => void>();
/** Be told each time a tool plugin is added or removed. */
export const onToolsChanged = (l: () => void): void => { toolListeners.add(l); };
export const toolsChanged = (): void => {
  broadcast("tools:changed");
  for (const l of toolListeners) l();
};

/** The program on PATH, by absolute path, never one inside `cwd`: a repository can ship a file
 *  named like the program, and Windows looks in the working folder first. */
async function resolveBin(bin: string, cwd: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(bin)) return null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const here = path.resolve(cwd);
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const dir = path.resolve(d);
    if (dir === here || dir.startsWith(here + path.sep)) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try { await access(full, constants.X_OK); if ((await stat(full)).isFile()) return full; } catch { /* next */ }
    }
  }
  return null;
}

function runFile(bin: string, args: string[], cwd: string, stdin?: string): Promise<ToolRunResult> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** Answers asked for with `maxAgeMs`, shared by every tile asking the same; at most `CACHE_BYTES` of output. */
const cache = new Map<string, { at: number; bytes: number; out: Promise<ToolRunResult> }>();
const CACHE_BYTES = 32 * 1024 * 1024;
let cached = 0;

function remember(key: string, out: Promise<ToolRunResult>): void {
  const entry = { at: Date.now(), bytes: 0, out };
  cache.set(key, entry);
  void out.then((r) => {
    if (cache.get(key) !== entry) return;
    entry.bytes = r.stdout.length + r.stderr.length;
    cached += entry.bytes;
    for (const [k, e] of cache) {
      if (cached <= CACHE_BYTES) break;
      cache.delete(k);
      cached -= e.bytes;
    }
  });
}

export async function runTool(call: ToolRun): Promise<ToolRunResult> {
  const { bin, args, cwd } = call;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error("args must be a list of strings");
  if (!cwd || !path.isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error("a tile runs programs in its own folder, and this one has none");
  const age = Math.min(Math.max(call.maxAgeMs ?? 0, 0), 300_000);
  const key = JSON.stringify([bin, args, cwd]);
  const hit = age > 0 && call.stdin === undefined ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < age) return hit.out;
  const full = await resolveBin(bin, cwd);
  if (!full) throw new Error(`${bin} is not installed on this machine`);
  // A .cmd/.bat shim starts only through cmd.exe, which parses its arguments again.
  if (/\.(cmd|bat)$/i.test(full)) throw new Error(`${bin} is a script shim here, which a tile cannot run without a shell`);
  const out = runFile(full, args, cwd, call.stdin);
  if (age > 0 && call.stdin === undefined) remember(key, out);
  return out;
}

export function installToolPackageIpc(): void {
  handle("tools:list", async () => ({ packages: await listTools(), safeMode: safeMode() }));
  handle("tools:host-exports", (_e, map: unknown) => {
    if (typeof map !== "object" || map === null) return;
    hostExports = Object.fromEntries(Object.entries(map as Record<string, unknown>)
      .filter(([k, v]) => /^[a-z-]+$/.test(k) && Array.isArray(v))
      .map(([k, v]) => [k, (v as unknown[]).filter((n): n is string => typeof n === "string")]));
  });
  handle("tools:install", async (e) => {
    const win = appWindowOf(e.sender);
    const opts = { properties: ["openDirectory" as const], title: "Add a tool plugin" };
    const picked = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    const from = picked.filePaths[0];
    if (picked.canceled || !from) return null;
    const { record } = await installPackage(from);
    await reloadSettings();
    toolsChanged();
    return { id: record.id, name: record.name };
  }, { local: true });
  handle("tools:remove", async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("not a tool plugin");
    await removePlugin("tool", id);
    toolsChanged();
  });
  handle("tools:run", (_e, call: ToolRun) => runTool(call));

}
