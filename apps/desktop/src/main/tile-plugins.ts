/**
 * Tile plugins on this machine: `<userData>/tiles/<id>/`, each a `tile.json` and the `index.html`
 * its tiles show in a sandboxed frame, served over `hm-tile://<id>/` with a policy that lets the
 * page run its own code and reach nothing else. A plugin reaches the machine only through `tiles:call`,
 * and only for what its manifest declares and the person approved. Calls run on the machine of
 * the person using the tile, never on a host for a guest.
 */
import { execFile } from "node:child_process";
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
    const exec = Array.isArray(perms.exec) ? perms.exec.filter((b): b is string => typeof b === "string" && BIN.test(b)) : [];
    await readFile(path.join(dir, id, "index.html"));
    return { id, name: typeof meta.name === "string" ? meta.name.slice(0, 60) : id, kinds, permissions: { exec }, entry: `${TILE_SCHEME}://${id}/index.html` };
  } catch { return null; }
}

/** What each plugin was granted, keyed by id: the exact binaries the person agreed to. */
async function approvals(): Promise<Record<string, string[]>> {
  try { return JSON.parse(await readFile(approvalsFile(), "utf8")) as Record<string, string[]>; } catch { return {}; }
}

const granted = new Map<string, Set<string>>();

/** Ask once per plugin and per change in what it asks for; a refusal leaves it installed but unable to run anything. */
async function approve(p: TilePluginPackage, saved: Record<string, string[]>): Promise<Set<string>> {
  const asks = [...p.permissions.exec].sort();
  const had = saved[p.id];
  if (!asks.length) return new Set();
  if (had && asks.every((b) => had.includes(b))) return new Set(asks);
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Allow", "Don't allow"],
    defaultId: 1,
    cancelId: 1,
    message: `"${p.name}" wants to run programs on this machine`,
    detail: `It asks to run: ${asks.join(", ")}\n\nOnly in the folder its tile works in, and never through a shell.`,
  });
  saved[p.id] = response === 0 ? asks : [];
  await writeFile(approvalsFile(), JSON.stringify(saved, null, 2)).catch(() => {});
  return new Set(saved[p.id]);
}

export async function listTilePlugins(dir = tilePluginsDir()): Promise<TilePluginPackage[]> {
  const ids = (await readdir(dir).catch(() => [] as string[])).filter((id) => !id.startsWith(".")).sort();
  const found = (await Promise.all(ids.map((id) => readPlugin(dir, id)))).filter((p): p is TilePluginPackage => p !== null);
  const saved = await approvals();
  for (const p of found) granted.set(p.id, await approve(p, saved));
  return found;
}

// ponytail: one cache for every tile, so ten tiles polling the same command run it once per window.
const cache = new Map<string, { at: number; out: Promise<{ code: number; stdout: string; stderr: string }> }>();
const MAX_CACHE = 200;

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
  if (!call.cwd || !path.isAbsolute(call.cwd)) throw new Error("a tile plugin runs in its tile's folder, and this tile has none");
  const key = JSON.stringify([bin, args, call.cwd]);
  const hit = cache.get(key);
  const age = Math.min(Math.max(maxAgeMs ?? 0, 0), 300_000);
  if (hit && Date.now() - hit.at < age) return hit.out;
  const out = run(bin, args, call.cwd);
  cache.set(key, { at: Date.now(), out });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return out;
}

export function installTilePluginIpc(): void {
  handle("tiles:list", () => listTilePlugins());
  handle("tiles:call", (_e, call: TilePluginCall) => callTilePlugin(call));
}
