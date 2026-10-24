/** The plugin catalog: HiveHub lists every published agent, view, widget and tool, with every file's
 *  SHA-256 and the commit it came from. Content is pinned by hash, so a file that changed
 *  after listing fails the install instead of being trusted. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appMeetsMinVersion } from "@hivemind/agents";
import { AGENT_MANIFEST_FILE } from "@hivemind/agents/load";
import { MAX_INDEX_BYTES, checkPluginFolder, parseHubIndex, type CatalogEntry, type HubIndexReading, type PluginFile } from "@hivemind/hub";

export const DEFAULT_PLUGIN_INDEX = "https://hivehub.griiken.workers.dev/api/v1/index.json";

export const MAX_FILE = 20 << 20;
const MAX_TOTAL = 50 << 20;
const TIMEOUT_MS = 20_000;
/** The install is already on disk by the time we tell the registry; don't make anyone wait. */
const NOTE_TIMEOUT_MS = 3_000;

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

/** The hub's index as this app reads it: the entries, and each one it skipped with the reason. */
export async function fetchCatalog(indexUrl = catalogIndexUrl()): Promise<HubIndexReading> {
  const body = await read(new URL(indexUrl), MAX_INDEX_BYTES);
  return parseHubIndex(JSON.parse(body.toString("utf8")));
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

/** Where an entry's files are, relative to the index: under `source` when it names one, else beside the index. */
const folderOf = (entry: CatalogEntry): string =>
  `${entry.source ? `${entry.source.replace(/\/$/, "")}/` : ""}${entry.path ? `${entry.path}/` : ""}`;

/** Download an entry's files into a fresh folder, verifying each hash, and check the folder the way
 *  a hub checks it before listing it. Returns the folder. */
export async function stageEntry(entry: CatalogEntry, indexUrl = catalogIndexUrl()): Promise<string> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `hm-plugin-${entry.id.replace(/[^a-z0-9-]/g, "_")}-`));
  try {
    let total = 0;
    const folder: PluginFile[] = [];
    for (const f of entry.files) {
      const body = await read(new URL(f.path, new URL(folderOf(entry), indexUrl)), MAX_FILE);
      total += body.length;
      if (total > MAX_TOTAL) throw new Error(`${entry.name} is larger than allowed`);
      if (createHash("sha256").update(body).digest("hex") !== f.sha256) {
        throw new Error(`${f.path} does not match the catalog: it changed after it was listed`);
      }
      const dest = path.join(stage, f.path);
      if (!dest.startsWith(stage + path.sep)) throw new Error(`${f.path} escapes the plugin folder`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, body);
      folder.push({ path: f.path, bytes: body });
    }
    const checked = await checkPluginFolder(folder);
    if ("problem" in checked) throw new Error(`${entry.id} is not a plugin Hivemind accepts: ${checked.problem}`);
    if (checked.plugin.type !== entry.type || checked.plugin.id !== entry.id) {
      throw new Error(`${entry.id}'s folder says it is "${checked.plugin.id}", not ${entry.id}`);
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
  const base = folderOf(entry);
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

/** Why this app cannot install `entry`, said before anything is downloaded: a plugin that needs a
 *  newer Hivemind fails at use, after the person has reviewed and installed it. Null when it can. */
export function needsNewerApp(entry: Pick<CatalogEntry, "name" | "minAppVersion">, appVersion: string): string | null {
  return appMeetsMinVersion(appVersion, entry.minAppVersion) ? null : `${entry.name} needs Hivemind ${entry.minAppVersion} or newer; this is ${appVersion}.`;
}

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
