/** The plugin catalog: HiveHub lists every published agent, view, widget and tool, with every file's
 *  SHA-256 and the commit it came from. Content is pinned by hash, so a file that changed
 *  after listing fails the install instead of being trusted. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_APP_VERSION_RE, appMeetsMinVersion } from "@hivemind/agents";
import { AGENT_MANIFEST_FILE } from "@hivemind/agents/load";
import { TOOL_ID_RE } from "./tool-registry.js";

export const DEFAULT_PLUGIN_INDEX = "https://hivehub.griiken.workers.dev/api/v1/index.json";

export type CatalogType = "agent" | "view" | "widget" | "tool" | "package";
const TYPES: readonly string[] = ["agent", "view", "widget", "tool", "package"];
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
  /** Packages only: what it holds, as HiveHub read it, so it can be shown before anything is
   *  downloaded. The install checks every member again from the files. */
  members?: CatalogMember[];
}
export interface CatalogMember { kind: string; id: string; name: string; permissions: string[] }

// A view, a widget or a tool carries its publisher's scope; an agent is one name for one CLI,
// settled in the plugins repository. A tool's folder is owner--name, so neither part holds "--".
const SCOPED = /^(?!.*--)@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL = new RegExp(`^(?!.*--)${TOOL_ID_RE.source.slice(1)}`);
const ID_RE: Record<CatalogType, RegExp> = { view: SCOPED, widget: SCOPED, package: SCOPED, tool: TOOL, agent: /^[a-z0-9][a-z0-9-]{0,31}$/ };
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;
export const MAX_FILE = 20 << 20;
const MAX_TOTAL = 50 << 20;
const TIMEOUT_MS = 20_000;
/** The install is already on disk by the time we tell the registry; don't make anyone wait. */
const NOTE_TIMEOUT_MS = 3_000;

/** Windows device names cannot be files, whatever the extension. */
const DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** Relative, no `..`, no absolute paths, no odd characters. */
const safeRelative = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length < 300
  && p.split("/").every((s) => SEGMENT_RE.test(s) && s !== ".." && !DEVICE_RE.test(s));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** A version 1 index. A kind this app does not know is left out, so a registry that lists a new
 *  kind does not take the whole catalog away. */
export function parseCatalog(raw: unknown): CatalogEntry[] {
  const doc = raw as { version?: unknown; plugins?: unknown };
  if (!doc || doc.version !== 1 || !Array.isArray(doc.plugins)) throw new Error("not a version 1 plugin index");
  const seen = new Set<string>();
  const known = doc.plugins.slice(0, 500).filter((p: unknown) => !!p && typeof p === "object" && TYPES.includes((p as { type?: unknown }).type as string));
  return known.map((p: Record<string, unknown>, i) => {
    const at = `plugins[${i}]`;
    const type = p.type as CatalogType;
    if (typeof p.id !== "string" || !ID_RE[type].test(p.id)) {
      throw new Error(`${at}.id is not ${type === "agent" ? "an agent id — it must be one name" : `a ${type} id — it must be @owner/name`}`);
    }
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
    if (p.minAppVersion !== undefined && (typeof p.minAppVersion !== "string" || !MIN_APP_VERSION_RE.test(p.minAppVersion))) {
      throw new Error(`${at}.minAppVersion must look like 1.2.3`);
    }
    if (p.icon !== undefined && (typeof p.icon !== "object" || p.icon === null || JSON.stringify(p.icon).length > 4096)) {
      throw new Error(`${at}.icon must be a small object`);
    }
    if (p.bin !== undefined && (p.type !== "agent" || typeof p.bin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.bin))) {
      throw new Error(`${at}.bin must be the bare name of an agent's CLI`);
    }
    const members = p.members === undefined ? undefined : parseMembers(p.members, at, type);
    return { id: p.id, type, name: p.name, description: p.description, author: p.author, version: p.version, path: p.path, files,
      ...(homepage ? { homepage } : {}), ...(typeof p.source === "string" ? { source: p.source } : {}),
      ...(typeof p.bin === "string" ? { bin: p.bin } : {}),
      ...(typeof p.minAppVersion === "string" ? { minAppVersion: p.minAppVersion } : {}),
      ...(p.icon !== undefined ? { icon: p.icon } : {}),
      ...(members ? { members } : {}) };
  });
}

function parseMembers(raw: unknown, at: string, type: CatalogType): CatalogMember[] {
  if (type !== "package" || !Array.isArray(raw) || !raw.length || raw.length > 64) throw new Error(`${at}.members must list 1-64 members of a package`);
  return raw.map((m: Record<string, unknown>, j) => {
    if (!m || !text(m.kind, 40) || typeof m.id !== "string" || !SCOPED.test(m.id) || !text(m.name, 120)
      || !Array.isArray(m.permissions) || m.permissions.length > 32 || !m.permissions.every((x) => text(x, 80))) {
      throw new Error(`${at}.members[${j}] needs a kind, an @owner/name id, a name and its permissions`);
    }
    return { kind: m.kind, id: m.id, name: m.name, permissions: m.permissions as string[] };
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

/** Tell the registry a plugin was installed, so its count is a count.
 *
 *  The registry counts the request, not anything we volunteer: it dedupes on an HMAC of
 *  (day, plugin, address), so installing the same plugin five times on one machine counts
 *  once, and the fingerprint is not an identifier for anyone. We therefore send no id, no
 *  machine name and no headers of our own — and never let it fail an install.
 *
 *  Only catalog installs reach this. A plugin installed from a folder was never resolved
 *  from the registry and is not its to count. */
export async function noteInstall(entry: CatalogEntry, indexUrl = catalogIndexUrl()): Promise<void> {
  try {
    const url = new URL(`plugins/${entry.id.split("/").map(encodeURIComponent).join("/")}/resolve`, indexUrl);
    if (url.protocol !== "https:") return;
    await fetch(url, { signal: AbortSignal.timeout(NOTE_TIMEOUT_MS), redirect: "error" });
  } catch {
    /* the plugin is installed either way — a count is never worth an error */
  }
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
    await noteInstall(entry, indexUrl);
    return stage;
  } catch (e) {
    await fs.rm(stage, { recursive: true, force: true });
    throw e;
  }
}

/** The most a plugin's README may take. */
const MAX_README = 256 * 1024;

/** A catalog plugin's README.md, read before anything is installed: checked against its hash
 *  when the entry lists it as one of its files, else read as is (it is shown, never run), or
 *  null when it has none. */
export async function fetchReadme(entry: CatalogEntry, indexUrl = catalogIndexUrl()): Promise<string | null> {
  const base = entry.source ? `${entry.source.replace(/\/$/, "")}/${entry.path}/` : `${entry.path}/`;
  const listed = entry.files.find((f) => /^readme\.md$/i.test(f.path));
  try {
    const body = await read(new URL(listed?.path ?? "README.md", new URL(base, indexUrl)), MAX_README);
    if (listed && createHash("sha256").update(body).digest("hex") !== listed.sha256) return null;
    return body.toString("utf8");
  } catch {
    return null;
  }
}

// A plugin that needs a Hivemind you do not have must say so before it is downloaded,
// not fail once it is installed.
export { appMeetsMinVersion };

/** Whether an installed agent should become the catalog's current one. Two cases: it is
 *  `broken` — this app refuses its manifest, so it is doing nothing at all and the catalog's
 *  copy can only be better — or it is the catalog's copy and nobody edited it since: recorded
 *  so (`recordedSha` is the manifest hash the catalog installed, null for an install from before
 *  that was recorded), or `published`, its bytes a version the catalog published. Either way
 *  this app must be able to run what the catalog lists. */
export function catalogAgentNeedsUpdate(entry: CatalogEntry, installed: {
  fromCatalog: boolean; manifestSha: string; recordedSha: string | null; appVersion: string;
  /** The installed manifest does not load in this app. */
  broken?: boolean;
  /** The installed manifest is byte for byte a file of the catalog's repository (catalogRepoHolds). */
  published?: boolean;
}): boolean {
  if (entry.type !== "agent") return false;
  if (!appMeetsMinVersion(installed.appVersion, entry.minAppVersion)) return false;
  if (installed.broken) return true;
  const want = entry.files.find((f) => f.path === AGENT_MANIFEST_FILE)?.sha256;
  if (!want || want === installed.manifestSha) return false;
  if (installed.published) return true;
  if (!installed.fromCatalog) return false;
  return installed.recordedSha === null || installed.recordedSha === installed.manifestSha;
}

/** Whether `body` is a file the catalog's repository holds in some commit. A copy nobody recorded
 *  installing (an older app's, or `hive agents install`'s) is then the catalog's own, untouched;
 *  a copy someone edited is not. GitHub names a file's bytes by their git blob id. */
export async function catalogRepoHolds(entry: CatalogEntry, body: Uint8Array): Promise<boolean> {
  const repo = entry.source?.match(/^https:\/\/raw\.githubusercontent\.com\/([\w.-]+\/[\w.-]+)\//)?.[1];
  if (!repo) return false;
  const blob = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${blob}`,
      { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers: { "user-agent": "hivemind" } });
    return res.status === 200;
  } catch {
    return false;
  }
}
