/**
 * Tile plugins on this machine: `<userData>/tiles/<id>/`, each a `tile.json` and the `index.html`
 * its tiles show in a sandboxed frame, served over `hm-tile://<id>/` with a policy that lets the
 * page run its own code and reach nothing else. A plugin reaches the machine only through `tiles:call`,
 * and only for what its manifest declares and the person approved. Calls run on the machine of
 * the person using the tile, never on a host for a guest.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, dialog, net, protocol } from "electron";
import { handle } from "./app-ipc.js";
import type { TilePluginCall, TilePluginPackage, TilePluginKind } from "../shared/ipc.js";

export const tilePluginsDir = (): string => path.join(app.getPath("userData"), "tiles");
const approvalsFile = (): string => path.join(tilePluginsDir(), ".approved.json");

export const TILE_SCHEME = "hm-tile";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CSP = [
  "default-src 'none'", `script-src ${TILE_SCHEME}: 'unsafe-inline'`, `style-src ${TILE_SCHEME}: 'unsafe-inline'`,
  `img-src ${TILE_SCHEME}: data:`, `font-src ${TILE_SCHEME}: data:`, "connect-src 'none'", "frame-src 'none'", "form-action 'none'",
].join("; ");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
};

/** Call after app ready. Serves only files inside a listed plugin's own folder. */
export function handleTileProtocol(): void {
  protocol.handle(TILE_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      if (!granted.has(u.host)) return new Response("unknown tile plugin", { status: 404 });
      const root = path.join(tilePluginsDir(), u.host);
      const file = path.resolve(root, decodeURIComponent(u.pathname.replace(/^\/+/, "")) || "index.html");
      if (!file.startsWith(root + path.sep)) return new Response("forbidden", { status: 403 });
      const type = TYPES[path.extname(file).toLowerCase()];
      if (!type) return new Response("not served", { status: 403 });
      const res = await net.fetch(pathToFileURL(file).toString());
      return new Response(res.body, { status: res.status, headers: {
        "Content-Type": type, "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
      } });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  });
}
const BIN = /^[A-Za-z0-9._-]{1,64}$/;
/** Programs that run whatever code they are handed: granting one would grant everything. */
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh", "env", "xargs", "sudo", "doas", "su",
  "node", "bun", "deno", "python", "python3", "perl", "ruby", "php", "lua", "osascript", "wscript", "cscript", "mshta", "rundll32",
  "npx", "pnpx", "bunx", "ssh", "eval", "exec", "nohup", "nice", "timeout", "watch", "find", "awk", "sed", "make",
]);

function kindsOf(raw: unknown): Record<string, TilePluginKind> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: Record<string, TilePluginKind> = {};
  for (const [kind, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ID.test(kind) || typeof v !== "object" || v === null) return null;
    const k = v as Record<string, unknown>;
    const n = (x: unknown, d: number) => (typeof x === "number" && x >= 160 && x <= 4000 ? x : d);
    const size = (k.size ?? {}) as Record<string, unknown>;
    out[kind] = {
      title: typeof k.title === "string" ? k.title.slice(0, 40) : kind,
      glyph: typeof k.glyph === "string" ? k.glyph.slice(0, 2) : undefined,
      size: { width: n(size.width, 900), height: n(size.height, 640) },
      needsRepo: k.needsRepo === true,
      singleton: k.singleton === true,
    };
  }
  return Object.keys(out).length ? out : null;
}

async function readPlugin(dir: string, id: string): Promise<TilePluginPackage | null> {
  if (!ID.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(dir, id, "tile.json"), "utf8")) as Record<string, unknown>;
    const kinds = kindsOf(meta.kinds);
    if (!kinds) return null;
    const perms = (meta.permissions ?? {}) as Record<string, unknown>;
    const exec = Array.isArray(perms.exec)
      ? perms.exec.filter((b): b is string => typeof b === "string" && BIN.test(b) && !INTERPRETERS.has(b.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "")))
      : [];
    await readFile(path.join(dir, id, "index.html"));
    return { id, name: typeof meta.name === "string" ? meta.name.slice(0, 60) : id, kinds, permissions: { exec }, entry: `${TILE_SCHEME}://${id}/index.html` };
  } catch { return null; }
}

type Approval = { bins: string[]; hash: string };
/** What each plugin was granted, keyed by id: the exact binaries the person agreed to, for the
 *  exact files they agreed to them for. */
async function approvals(): Promise<Record<string, Approval>> {
  try { return JSON.parse(await readFile(approvalsFile(), "utf8")) as Record<string, Approval>; } catch { return {}; }
}

/** One hash over every file in a plugin's folder, so changed code has to be allowed again. */
async function folderHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) h.update(r).update("\0").update(await readFile(path.join(dir, r))).update("\0");
    }
  };
  await walk("");
  return h.digest("hex");
}

const granted = new Map<string, Set<string>>();

/** Ask once per plugin and per change in what it asks for; a refusal leaves it installed but unable to run anything. */
async function approve(p: TilePluginPackage, dir: string, saved: Record<string, Approval>): Promise<Set<string>> {
  const asks = [...p.permissions.exec].sort();
  if (!asks.length) return new Set();
  const hash = await folderHash(path.join(dir, p.id));
  const had = saved[p.id];
  if (had?.hash === hash && asks.every((b) => had.bins.includes(b))) return new Set(asks);
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Allow", "Don't allow"],
    defaultId: 1,
    cancelId: 1,
    message: `"${p.name}" wants to run programs on this machine`,
    detail: `It asks to run: ${asks.join(", ")}\n\nIt can then do anything those programs can do, as you, with any arguments: `
      + `for gh, act on GitHub with your login. It runs them in its tile's folder, never through a shell. `
      + `If its files change, you will be asked again.`,
  });
  saved[p.id] = { bins: response === 0 ? asks : [], hash };
  await writeFile(approvalsFile(), JSON.stringify(saved, null, 2)).catch(() => {});
  return new Set(saved[p.id]!.bins);
}

export async function listTilePlugins(dir = tilePluginsDir()): Promise<TilePluginPackage[]> {
  const ids = (await readdir(dir).catch(() => [] as string[])).filter((id) => !id.startsWith(".")).sort();
  const found = (await Promise.all(ids.map((id) => readPlugin(dir, id)))).filter((p): p is TilePluginPackage => p !== null);
  const saved = await approvals();
  for (const p of found) granted.set(p.id, await approve(p, dir, saved));
  return found;
}

// ponytail: one cache for every tile, so ten tiles polling the same command run it once per window.
const cache = new Map<string, { at: number; out: Promise<{ code: number; stdout: string; stderr: string }> }>();
const MAX_CACHE = 200;

/** The program on PATH, by absolute path, never one in the tile's folder: a repo can ship a
 *  file named like the program, and Windows looks in the working folder first. */
async function resolveBin(bin: string, cwd: string): Promise<string | null> {
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

function run(bin: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
    });
  });
}

export async function callTilePlugin(call: TilePluginCall): Promise<unknown> {
  if (call.method !== "exec") throw new Error(`a tile plugin has no "${call.method}"`);
  const { bin, args, maxAgeMs } = call;
  if (!granted.get(call.plugin)?.has(bin)) throw new Error(`"${call.plugin}" may not run ${bin}: it was not declared, or not allowed`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error("args must be a list of strings");
  if (!call.cwd || !path.isAbsolute(call.cwd) || !(await stat(call.cwd).catch(() => null))?.isDirectory()) {
    throw new Error("a tile plugin runs in its tile's folder, and this tile has none");
  }
  const key = JSON.stringify([bin, args, call.cwd]);
  const hit = cache.get(key);
  const age = Math.min(Math.max(maxAgeMs ?? 0, 0), 300_000);
  if (hit && Date.now() - hit.at < age) return hit.out;
  const full = await resolveBin(bin, call.cwd);
  if (!full) throw new Error(`${bin} is not installed on this machine`);
  // A .cmd/.bat shim can only start through cmd.exe, which re-parses arguments: refuse it.
  if (/\.(cmd|bat)$/i.test(full)) throw new Error(`${bin} is a script shim here, which a tile plugin may not run`);
  const out = run(full, args, call.cwd);
  cache.set(key, { at: Date.now(), out });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return out;
}

export function installTilePluginIpc(): void {
  handle("tiles:list", () => listTilePlugins());
  handle("tiles:call", (_e, call: TilePluginCall) => callTilePlugin(call));
}
