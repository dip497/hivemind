/** The plugin index a hub serves and the app reads: version 1, a list of plugins, each with the
 *  SHA-256 of every file. Every hub is built with this module and the app reads with it, so a
 *  hub cannot list what the app would refuse to read.
 *
 *  An entry this app cannot read is skipped with the reason, never the whole index: hubs are
 *  updated on their own schedules, and one entry from a newer format must not empty a catalog. */
import { MIN_APP_VERSION_RE } from "@hivemind/agents";
import { TOOL_ID_RE } from "@hivemind/core/tool-registry";
import { parseCategory, type PluginCategory } from "@hivemind/view-sdk/category";

export { CATEGORY_LABELS, PLUGIN_CATEGORIES, type PluginCategory } from "@hivemind/view-sdk/category";

export type CatalogType = "agent" | "view" | "widget" | "tool";
const TYPES: readonly string[] = ["agent", "view", "widget", "tool"];
export interface CatalogFile { path: string; sha256: string }
export interface CatalogEntry {
  id: string;
  type: CatalogType;
  name: string;
  description: string;
  author: string;
  version: string;
  /** Folder of the plugin's files, relative to the index — or to `source` when set. Empty when
   *  the files sit at that base itself, as a plugin published from a repository's root does. */
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
  /** What it is for, as its manifest says; an agent is always `agents`, and one the app does not
   *  know is `other`. */
  category?: PluginCategory;
}

/** An entry left out of the index, and why. `position` is its place in the index's `plugins`. */
export interface SkippedEntry { position: number; id: string | null; reason: string }
export interface HubIndexReading { plugins: CatalogEntry[]; skipped: SkippedEntry[] }

/** The most entries one index may list. An average entry is about 1.7 KB as served (HiveHub's
 *  52 entries were 88,060 bytes, 69,261 compact), so 2,000 fit well inside MAX_INDEX_BYTES. */
export const MAX_INDEX_ENTRIES = 2000;
/** The most bytes one index may be. */
export const MAX_INDEX_BYTES = 4 << 20;

// A view or a widget carries its publisher's scope; an agent is one name for one CLI, settled in
// the plugins repository; a tool is the app's own tool id, owner/name, whose folder is owner--name.
const SCOPED = /^(?!.*--)@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL = new RegExp(`^(?!.*--)${TOOL_ID_RE.source.slice(1)}`);
const ID_RE: Record<CatalogType, RegExp> = { view: SCOPED, widget: SCOPED, tool: TOOL, agent: /^[a-z0-9][a-z0-9-]{0,31}$/ };
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Windows device names cannot be files, whatever the extension. */
const DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** Relative, no `..`, no absolute paths, no odd characters. */
export const safeRelative = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length < 300
  && p.split("/").every((s) => SEGMENT_RE.test(s) && s !== ".." && !DEVICE_RE.test(s));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

class Unreadable extends Error {}
const refuse = (reason: string): never => { throw new Unreadable(reason); };

const idRule: Record<CatalogType, string> = {
  agent: "an agent id — it must be one name",
  tool: "a tool id — it must be owner/name",
  view: "a view id — it must be @owner/name",
  widget: "a widget id — it must be @owner/name",
};

/** Why `id` cannot be a listed plugin of this kind, or null. */
export const idProblem = (type: CatalogType, id: unknown): string | null =>
  typeof id === "string" && ID_RE[type].test(id) ? null : `its id is not ${idRule[type]}`;

/** One entry as this app reads it, or throws Unreadable with the reason. */
function readEntry(p: Record<string, unknown>): CatalogEntry {
  const type = p.type as CatalogType;
  const badId = idProblem(type, p.id);
  if (badId) refuse(badId);
  if (!text(p.name, 80) || !text(p.description, 400) || !text(p.author, 80) || !text(p.version, 40)) {
    refuse("it needs a name, description, author and version");
  }
  if (p.path !== "" && !safeRelative(p.path)) refuse("its path must be a relative folder");
  if (!Array.isArray(p.files) || !p.files.length || p.files.length > 200) refuse("its files must list 1-200 files");
  const files = (p.files as Record<string, unknown>[]).map((f, j) => {
    if (!f || !safeRelative(f.path) || typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256)) {
      refuse(`files[${j}] needs a relative path and a sha256`);
    }
    return { path: f.path as string, sha256: f.sha256 as string };
  });
  const homepage = typeof p.homepage === "string" && /^https:\/\/\S+$/.test(p.homepage) ? p.homepage : undefined;
  // A plugin may keep its own repository; the hash still decides whether its files are
  // the ones that were listed, so where they came from changes nothing about trust.
  if (p.source !== undefined && (typeof p.source !== "string" || !/^https:\/\/[^\s?#]+$/.test(p.source) || p.source.includes(".."))) {
    refuse("its source must be an https base URL");
  }
  if (p.minAppVersion !== undefined && (typeof p.minAppVersion !== "string" || !MIN_APP_VERSION_RE.test(p.minAppVersion))) {
    refuse("its minAppVersion must look like 1.2.3");
  }
  if (p.icon !== undefined && (typeof p.icon !== "object" || p.icon === null || JSON.stringify(p.icon).length > 4096)) {
    refuse("its icon must be a small object");
  }
  if (p.bin !== undefined && (type !== "agent" || typeof p.bin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.bin))) {
    refuse("its bin must be the bare name of an agent's CLI");
  }
  const said = parseCategory(p.category);
  const category: PluginCategory = type === "agent" ? "agents" : "category" in said ? said.category : "other";
  return { id: p.id as string, type, name: p.name as string, description: p.description as string, author: p.author as string,
    version: p.version as string, path: p.path as string, files,
    ...(homepage ? { homepage } : {}), ...(typeof p.source === "string" ? { source: p.source } : {}),
    ...(typeof p.bin === "string" ? { bin: p.bin } : {}),
    ...(typeof p.minAppVersion === "string" ? { minAppVersion: p.minAppVersion } : {}),
    ...(p.icon !== undefined ? { icon: p.icon } : {}), category };
}

/** A version 1 index: every entry this app can read, and each one it cannot with the reason.
 *  Throws only when the document is not a version 1 index at all. */
export function parseHubIndex(raw: unknown): HubIndexReading {
  const doc = raw as { version?: unknown; plugins?: unknown };
  if (!doc || doc.version !== 1 || !Array.isArray(doc.plugins)) throw new Error("not a version 1 plugin index");
  const plugins: CatalogEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();
  doc.plugins.slice(0, MAX_INDEX_ENTRIES).forEach((p: unknown, position) => {
    const record = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    try {
      if (!TYPES.includes(record.type as string)) refuse(`its type, ${JSON.stringify(record.type ?? null)}, is not a kind this Hivemind knows`);
      const entry = readEntry(record);
      const key = `${entry.type}:${entry.id}`;
      if (seen.has(key)) refuse(`${key} is listed earlier in the index`);
      seen.add(key);
      plugins.push(entry);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      skipped.push({ position, id, reason: e.message });
    }
  });
  if (doc.plugins.length > MAX_INDEX_ENTRIES) {
    skipped.push({ position: MAX_INDEX_ENTRIES, id: null,
      reason: `the index lists ${doc.plugins.length} plugins; Hivemind reads the first ${MAX_INDEX_ENTRIES}` });
  }
  return { plugins, skipped };
}

/** The index a hub serves: only the entries the app reads, as it reads them, and the rest named. */
export function writeHubIndex(entries: readonly unknown[]): { index: { version: 1; plugins: CatalogEntry[] }; skipped: SkippedEntry[] } {
  const { plugins, skipped } = parseHubIndex({ version: 1, plugins: entries });
  return { index: { version: 1, plugins }, skipped };
}
