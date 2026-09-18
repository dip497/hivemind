/**
 * hivemind-view.json — the manifest a community view ships next to its entry.
 * Validated by `hive views install`, by the desktop loader, and (through this
 * module) by plugin authors' own builds. Pure: no filesystem here.
 */
import { PROTOCOL_VERSION, VIEW_PERMISSIONS, type ViewPermission } from "./protocol.js";

export const MANIFEST_FILE = "hivemind-view.json";

export interface ViewManifest {
  /** Stable id: install path, registry id, layout-blob key. `name`, or `@owner/name` when it
   *  was published on HiveHub — `owner` is the GitHub account that published it. */
  id: string;
  name: string;
  /** semver-ish `x.y.z` (shown in `hive views list`; not compared by the host). */
  version: string;
  /** Relative path to ONE bundled `.html` (loaded as-is) or `.js` (wrapped in a
   *  host-generated page as a module script). Everything it references must sit
   *  under the package dir and be relative. */
  entry: string;
  /** Protocol version the plugin speaks; a host refuses a newer one at load. */
  protocol: number;
  /** What the plugin may ask for beyond the base (projection, status, selection,
   *  reveal, surfaces). Unknown names are refused at install AND at load. */
  permissions: ViewPermission[];
  /** Optional relative dir served alongside the entry (default: the whole package dir). */
  assets?: string;
  /** Who wrote it, where it came from, and under what terms — shown wherever the user is
   *  asked to trust it. These are the PACKAGE'S OWN CLAIMS: nothing here is verified, and a
   *  host must never present them as if they were. A registry's verified owner is separate. */
  author?: string;
  homepage?: string;
  license?: string;
  /** The user's wallpaper is mounted behind the view unless this says otherwise. A view that
   *  paints an opaque scene of its own sets it to false: nothing would show through, and the
   *  wallpaper's animation and blur would still cost every frame. */
  wallpaper?: boolean;
}

// A bare name is built in or installed from a folder; `@owner/name` came from HiveHub. `--` is
// refused because the scoped form becomes a hostname by turning `@owner/name` into `owner--name`,
// and a bare id must never be able to pass for one.
const ID_RE = /^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9-]{1,63}$/;

/** The sandbox origin's hostname for a view: the id itself, or `owner--name` for a scoped one.
 *  A hostname cannot hold `@` or `/`, and a label is at most 63 characters. */
export const viewHost = (id: string) => (id.startsWith("@") ? id.slice(1).replace("/", "--") : id);

/** Whether a string is a usable view id — the one check everything that takes an id uses. */
export const isViewId = (id: string) => ID_RE.test(id) && viewHost(id).length <= 63;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** A relative path that cannot leave the package dir. */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export type ManifestResult = { ok: true; manifest: ViewManifest } | { ok: false; errors: string[] };

/** Validate a parsed `hivemind-view.json`. Every problem is reported, not just the first. */
export function validateViewManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["manifest must be a JSON object"] };
  const m = raw as Record<string, unknown>;
  const str = (k: string, max = 128): string | null => {
    const v = m[k];
    if (typeof v !== "string" || v.trim().length === 0) { errors.push(`"${k}" must be a non-empty string`); return null; }
    if (v.length > max) { errors.push(`"${k}" is longer than ${max} characters`); return null; }
    return v;
  };
  const id = str("id", 105);
  if (id !== null && !ID_RE.test(id)) errors.push(`"id" must be a name or @owner/name, lowercase letters, digits and single dashes (got ${JSON.stringify(id)})`);
  else if (id !== null && viewHost(id).length > 63) errors.push(`"id" is too long: owner and name together must fit in 61 characters`);
  const name = str("name", 64);
  const version = str("version", 64);
  if (version !== null && !VERSION_RE.test(version)) errors.push(`"version" must look like 1.2.3 (got ${JSON.stringify(version)})`);
  const entry = str("entry", 256);
  if (entry !== null) {
    if (!isSafeRelativePath(entry)) errors.push(`"entry" must be a relative path inside the package (got ${JSON.stringify(entry)})`);
    else if (!/\.(html|js)$/.test(entry)) errors.push(`"entry" must end in .html or .js (got ${JSON.stringify(entry)})`);
  }
  let protocol = PROTOCOL_VERSION;
  if (m.protocol !== undefined) {
    if (typeof m.protocol !== "number" || !Number.isInteger(m.protocol) || m.protocol < 1) errors.push(`"protocol" must be a positive integer`);
    else protocol = m.protocol;
  }
  const permissions: ViewPermission[] = [];
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) errors.push(`"permissions" must be an array`);
    else for (const p of m.permissions) {
      if (typeof p !== "string" || !(VIEW_PERMISSIONS as readonly string[]).includes(p)) errors.push(`unknown permission ${JSON.stringify(p)} (known: ${VIEW_PERMISSIONS.join(", ")})`);
      else if (!permissions.includes(p as ViewPermission)) permissions.push(p as ViewPermission);
    }
  }
  let author: string | undefined;
  if (m.author !== undefined) {
    if (typeof m.author !== "string" || m.author.trim().length === 0 || m.author.length > 80) errors.push(`"author" must be a non-empty string of at most 80 characters`);
    else author = m.author;
  }
  let homepage: string | undefined;
  if (m.homepage !== undefined) {
    // https only: a plugin's own link is opened in the user's browser.
    if (typeof m.homepage !== "string" || !/^https:\/\/\S{1,200}$/.test(m.homepage)) errors.push(`"homepage" must be an https:// URL`);
    else homepage = m.homepage;
  }
  let license: string | undefined;
  if (m.license !== undefined) {
    if (typeof m.license !== "string" || !/^[A-Za-z0-9.+-]{1,40}$/.test(m.license)) errors.push(`"license" must be a short identifier like MIT or Apache-2.0`);
    else license = m.license;
  }
  let wallpaper: boolean | undefined;
  if (m.wallpaper !== undefined) {
    if (typeof m.wallpaper !== "boolean") errors.push(`"wallpaper" must be true or false`);
    else wallpaper = m.wallpaper;
  }
  let assets: string | undefined;
  if (m.assets !== undefined) {
    if (typeof m.assets !== "string" || !isSafeRelativePath(m.assets)) errors.push(`"assets" must be a relative path inside the package`);
    else assets = m.assets;
  }
  for (const k of Object.keys(m)) if (!["id", "name", "version", "entry", "protocol", "permissions", "assets", "wallpaper", "author", "homepage", "license"].includes(k)) errors.push(`unknown field "${k}"`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { id: id!, name: name!, version: version!, entry: entry!, protocol, permissions, ...(assets ? { assets } : {}), ...(wallpaper === undefined ? {} : { wallpaper }),
    ...(author ? { author } : {}), ...(homepage ? { homepage } : {}), ...(license ? { license } : {}) } };
}
