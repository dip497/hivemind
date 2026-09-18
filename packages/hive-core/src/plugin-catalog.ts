/** The plugin catalog: HiveHub lists every published agent and view, with every file's
 *  SHA-256 and the commit it came from. Content is pinned by hash, so a file that changed
 *  after listing fails the install instead of being trusted. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PLUGIN_INDEX = "https://hivehub.griiken.workers.dev/api/v1/index.json";

export type CatalogType = "agent" | "view";
export interface CatalogFile { path: string; sha256: string }
export interface CatalogEntry {
  id: string;
  type: CatalogType;
  name: string;
  description: string;
  author: string;
  version: string;
  /** Folder of the plugin's files, relative to the index — or to `source` when set. */
  path: string;
  /** Where this plugin's files live, when that is not beside the index. An https base URL,
   *  so a plugin can keep its own repository and the index stay a list. */
  source?: string;
  files: CatalogFile[];
  homepage?: string;
  /** Agents only: the CLI whose presence adds this agent automatically. */
  bin?: string;
  /** The oldest Hivemind this plugin runs on. Absent means any. */
  minAppVersion?: string;
  /** Agents only: the `icon` block of its manifest, so the list can show the agent's own
   *  mark before anything is downloaded. Bounded here and sanitised where it is drawn —
   *  this module does not know what an icon is, and must not start guessing. */
  icon?: unknown;
}

// Everything listed was published by someone, so every id carries its publisher's scope; a bare
// name is only ever something that ships inside the app.
const ID_RE = /^(?!.*--)@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;
export const MAX_FILE = 20 << 20;
const MAX_TOTAL = 50 << 20;
const TIMEOUT_MS = 20_000;

/** Windows device names cannot be files, whatever the extension. */
const DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** Relative, no `..`, no absolute paths, no odd characters. */
const safeRelative = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length < 300
  && p.split("/").every((s) => SEGMENT_RE.test(s) && s !== ".." && !DEVICE_RE.test(s));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function parseCatalog(raw: unknown): CatalogEntry[] {
  const doc = raw as { version?: unknown; plugins?: unknown };
  if (!doc || doc.version !== 1 || !Array.isArray(doc.plugins)) throw new Error("not a version 1 plugin index");
  const seen = new Set<string>();
  return doc.plugins.slice(0, 500).map((p: Record<string, unknown>, i) => {
    const at = `plugins[${i}]`;
    if (!p || typeof p !== "object") throw new Error(`${at} is not an object`);
    if (typeof p.id !== "string" || !ID_RE.test(p.id)) throw new Error(`${at}.id is not a plugin id — it must be @owner/name`);
    if (p.type !== "agent" && p.type !== "view") throw new Error(`${at}.type must be agent or view`);
    const key = `${p.type}:${p.id}`;
    if (seen.has(key)) throw new Error(`${at} lists ${key} twice`);
    seen.add(key);
    if (!text(p.name, 80) || !text(p.description, 400) || !text(p.author, 80) || !text(p.version, 40)) {
      throw new Error(`${at} needs a name, description, author and version`);
    }
    if (!safeRelative(p.path)) throw new Error(`${at}.path must be a relative folder`);
    if (!Array.isArray(p.files) || !p.files.length || p.files.length > 200) throw new Error(`${at}.files must list 1-200 files`);
    const files = p.files.map((f: Record<string, unknown>, j) => {
      if (!f || !safeRelative(f.path) || typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256)) {
        throw new Error(`${at}.files[${j}] needs a relative path and a sha256`);
      }
      return { path: f.path, sha256: f.sha256 };
    });
    const homepage = typeof p.homepage === "string" && /^https:\/\/\S+$/.test(p.homepage) ? p.homepage : undefined;
    // A plugin may keep its own repository; the hash still decides whether its files are
    // the ones that were listed, so where they came from changes nothing about trust.
    if (p.source !== undefined && (typeof p.source !== "string" || !/^https:\/\/[^\s?#]+$/.test(p.source) || p.source.includes(".."))) {
      throw new Error(`${at}.source must be an https base URL`);
    }
    if (p.minAppVersion !== undefined && (typeof p.minAppVersion !== "string" || !/^\d{1,4}(\.\d{1,4}){0,2}$/.test(p.minAppVersion))) {
      throw new Error(`${at}.minAppVersion must look like 1.2.3`);
    }
    if (p.icon !== undefined && (typeof p.icon !== "object" || p.icon === null || JSON.stringify(p.icon).length > 4096)) {
      throw new Error(`${at}.icon must be a small object`);
    }
        if (p.bin !== undefined && (p.type !== "agent" || typeof p.bin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.bin))) {
      throw new Error(`${at}.bin must be the bare name of an agent's CLI`);
    }
    return { id: p.id, type: p.type, name: p.name, description: p.description, author: p.author, version: p.version, path: p.path, files,
      ...(homepage ? { homepage } : {}), ...(typeof p.source === "string" ? { source: p.source } : {}),
      ...(typeof p.bin === "string" ? { bin: p.bin } : {}),
      ...(typeof p.minAppVersion === "string" ? { minAppVersion: p.minAppVersion } : {}),
      ...(p.icon !== undefined ? { icon: p.icon } : {}) };
  });
}

/** One file, over https (or a local file: index in development). Shared with the CLI, which
 *  fetches a plugin straight from its repository — there is no hash to pin against there, so
 *  the caps and the refusal to follow redirects are the whole of the protection. */
export async function readPluginFile(url: URL, cap: number): Promise<Buffer> {
  return read(url, cap);
}

async function read(url: URL, cap: number): Promise<Buffer> {
  if (url.protocol === "file:") {
    const file = fileURLToPath(url);
    const st = await fs.stat(file);
    if (st.size > cap) throw new Error(`${path.basename(file)} is larger than allowed`);
    return fs.readFile(file);
  }
  if (url.protocol !== "https:") throw new Error(`refusing to download from ${url.protocol}`);
  // No redirects: one could downgrade to http or leave the host the index named.
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!res.ok) throw new Error(`${url.pathname.split("/").pop()}: ${res.status} ${res.statusText}`);
  if (Number(res.headers.get("content-length") ?? 0) > cap) throw new Error("download is larger than allowed");
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done || !value) break;
    size += value.length;
    if (size > cap) { await reader!.cancel(); throw new Error("download is larger than allowed"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function catalogIndexUrl(): string {
  return process.env.HIVEMIND_PLUGIN_INDEX?.trim() || DEFAULT_PLUGIN_INDEX;
}

export async function fetchCatalog(indexUrl = catalogIndexUrl()): Promise<CatalogEntry[]> {
  const body = await read(new URL(indexUrl), 1 << 20);
  return parseCatalog(JSON.parse(body.toString("utf8")));
}

/** Download an entry's files into a fresh folder, verifying each hash. Returns the folder. */
export async function stageEntry(entry: CatalogEntry, indexUrl = catalogIndexUrl()): Promise<string> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `hm-plugin-${entry.id.replace(/[^a-z0-9-]/g, "_")}-`));
  try {
    let total = 0;
    for (const f of entry.files) {
      const base = entry.source ? `${entry.source.replace(/\/$/, "")}/${entry.path}/` : `${entry.path}/`;
      const body = await read(new URL(f.path, new URL(base, indexUrl)), MAX_FILE);
      total += body.length;
      if (total > MAX_TOTAL) throw new Error(`${entry.name} is larger than allowed`);
      if (createHash("sha256").update(body).digest("hex") !== f.sha256) {
        throw new Error(`${f.path} does not match the catalog: it changed after it was listed`);
      }
      const dest = path.join(stage, f.path);
      if (!dest.startsWith(stage + path.sep)) throw new Error(`${f.path} escapes the plugin folder`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, body);
    }
    return stage;
  } catch (e) {
    await fs.rm(stage, { recursive: true, force: true });
    throw e;
  }
}

/** Is this app new enough for that plugin? Numeric compare, missing parts are zero — a
 *  plugin that needs a Hivemind you do not have must say so before it is downloaded,
 *  not fail once it is installed. */
export function appMeetsMinVersion(appVersion: string, min: string | undefined): boolean {
  if (!min) return true;
  const parts = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(appVersion), want = parts(min);
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const a = have[i] ?? 0, b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
