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
  /** Its mark, so the list can show it before anything is downloaded: an agent's manifest `icon`
   *  block, or `{ image }`, a view's, widget's or tool's .svg as a data URL. Bounded here and
   *  sanitised where it is drawn. */
  icon?: unknown;
  /** What it is for, as its manifest says; an agent is always `agents`, and one the app does not
   *  know is `other`. */
  category?: PluginCategory;
  /** Packages only: what it holds, as the hub read it, so it can be shown before anything is
   *  downloaded. The install checks every member again from the files. */
  members?: CatalogMember[];
}
export interface CatalogMember { kind: string; id: string; name: string; permissions: string[] }

/** An entry left out of the index, and why. `position` is its place in the index's `plugins`. */
export interface SkippedEntry { position: number; id: string | null; reason: string }
export interface HubIndexReading { plugins: CatalogEntry[]; skipped: SkippedEntry[] }

/** The most entries one index may list. An average entry is about 1.7 KB as served (HiveHub's
 *  52 entries were 88,060 bytes, 69,261 compact), so 2,000 fit well inside MAX_INDEX_BYTES. */
export const MAX_INDEX_ENTRIES = 2000;
/** The most bytes one index may be. */
export const MAX_INDEX_BYTES = 4 << 20;

// A view, a widget, a tool or a package carries its publisher's scope; an agent is one name for one
// CLI, settled in the plugins repository. A tool's folder is owner--name, so no id holds "--".
const SCOPED = /^(?!.*--)@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL = new RegExp(`^(?!.*--)${TOOL_ID_RE.source.slice(1)}`);
const ID_RE: Record<CatalogType, RegExp> = { view: SCOPED, widget: SCOPED, package: SCOPED, tool: TOOL, agent: /^[a-z0-9][a-z0-9-]{0,31}$/ };
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Windows device names cannot be files, whatever the extension. */
const DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** Relative, no `..`, no absolute paths, no odd characters. */
export const safeRelative = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length < 300
  && p.split("/").every((s) => SEGMENT_RE.test(s) && s !== ".." && !DEVICE_RE.test(s));
/** Characters that can rewrite a terminal or reorder what is read: C0 and C1 controls, DEL, and
 *  the bidirectional overrides. Nothing a plugin shows needs them. */
export const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** Text a person reads: 1 to `max` characters, none of them unsafe. */
export const plainText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !UNSAFE_TEXT_RE.test(v);
const text = plainText;

/** Why these file paths cannot sit in one folder, or null: one named twice (letter case aside,
 *  as macOS and Windows see it), or one that is also the folder of another. */
export function pathsProblem(paths: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const p of paths) {
    const key = p.toLowerCase();
    if (seen.has(key)) return `${p} is listed twice`;
    seen.add(key);
  }
  for (const p of paths) {
    const parts = p.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/"))) return `${p} is inside ${parts.slice(0, i).join("/")}, which is a file`;
    }
  }
  return null;
}

/** Whether `v` is JSON of at most `max` characters; nesting too deep to write is not. */
/** A published .svg icon: HiveHub keeps ones up to 16 KiB, which base64 makes about 22 KiB. */
const isImageIcon = (v: unknown): boolean => {
  const image = (v as { image?: unknown } | null)?.image;
  return typeof image === "string" && image.startsWith("data:image/svg+xml;base64,") && image.length <= 32 << 10;
};

export const smallJson = (v: unknown, max: number): boolean => {
  try { return JSON.stringify(v).length <= max; } catch { return false; }
};

class Unreadable extends Error {}
const refuse = (reason: string): never => { throw new Unreadable(reason); };

const idRule: Record<CatalogType, string> = {
  agent: "an agent id — it must be one name",
  tool: "a tool id — it must be @owner/name",
  package: "a package id — it must be @owner/name",
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
    refuse("it needs a name, description, author and version, in plain text");
  }
  if (p.path !== "" && !safeRelative(p.path)) refuse("its path must be a relative folder");
  if (!Array.isArray(p.files) || !p.files.length || p.files.length > 200) refuse("its files must list 1-200 files");
  const files = (p.files as Record<string, unknown>[]).map((f, j) => {
    if (!f || !safeRelative(f.path) || typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256)) {
      refuse(`files[${j}] needs a relative path and a sha256`);
    }
    return { path: f.path as string, sha256: f.sha256 as string };
  });
  const clash = pathsProblem(files.map((f) => f.path));
  if (clash) refuse(`its files: ${clash}`);
  const homepage = typeof p.homepage === "string" && /^https:\/\/\S+$/.test(p.homepage) ? p.homepage : undefined;
  // A plugin may keep its own repository; the hash still decides whether its files are
  // the ones that were listed, so where they came from changes nothing about trust.
  if (p.source !== undefined && (typeof p.source !== "string" || !/^https:\/\/[^\s?#]+$/.test(p.source) || p.source.includes(".."))) {
    refuse("its source must be an https base URL");
  }
  if (p.minAppVersion !== undefined && (typeof p.minAppVersion !== "string" || !MIN_APP_VERSION_RE.test(p.minAppVersion))) {
    refuse("its minAppVersion must look like 1.2.3");
  }
  if (p.icon !== undefined && !isImageIcon(p.icon) && (typeof p.icon !== "object" || p.icon === null || !smallJson(p.icon, 4096))) {
    refuse("its icon must be a small object");
  }
  if (p.bin !== undefined && (type !== "agent" || typeof p.bin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.bin))) {
    refuse("its bin must be the bare name of an agent's CLI");
  }
  const members = p.members === undefined ? undefined : readMembers(p.members, type);
  const said = parseCategory(p.category);
  const category: PluginCategory = type === "agent" ? "agents" : "category" in said ? said.category : "other";
  return { id: p.id as string, type, name: p.name as string, description: p.description as string, author: p.author as string,
    version: p.version as string, path: p.path as string, files,
    ...(homepage ? { homepage } : {}), ...(typeof p.source === "string" ? { source: p.source } : {}),
    ...(typeof p.bin === "string" ? { bin: p.bin } : {}),
    ...(typeof p.minAppVersion === "string" ? { minAppVersion: p.minAppVersion } : {}),
    ...(p.icon !== undefined ? { icon: p.icon } : {}), category, ...(members ? { members } : {}) };
}

function readMembers(raw: unknown, type: CatalogType): CatalogMember[] {
  if (type !== "package" || !Array.isArray(raw) || !raw.length || raw.length > 64) refuse("its members must list 1-64 members of a package");
  return (raw as Record<string, unknown>[]).map((m, j) => {
    if (!m || typeof m !== "object" || !text(m.kind, 40) || typeof m.id !== "string" || !SCOPED.test(m.id) || !text(m.name, 120)
      || !Array.isArray(m.permissions) || m.permissions.length > 32 || !m.permissions.every((x) => text(x, 80))) {
      refuse(`members[${j}] needs a kind, an @owner/name id, a name and its permissions`);
    }
    return { kind: m.kind as string, id: m.id as string, name: m.name as string, permissions: m.permissions as string[] };
  });
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
    // Named only when it can be shown as it is: it is printed in terminals and logs.
    const id = plainText(record.id, 200) ? record.id : null;
    try {
      if (!TYPES.includes(record.type as string)) refuse(`its type, ${JSON.stringify(record.type ?? null)}, is not a kind this Hivemind knows`);
      const entry = readEntry(record);
      const key = `${entry.type}:${entry.id}`;
      if (seen.has(key)) refuse(`${key} is listed earlier in the index`);
      seen.add(key);
      plugins.push(entry);
    } catch (e) {
      // Whatever an entry holds, it costs only itself.
      skipped.push({ position, id, reason: e instanceof Unreadable ? e.message : "it cannot be read" });
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
