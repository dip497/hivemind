/**
 * hivemind-view.json — the manifest a community view ships next to its entry.
 * Validated by `hive views install`, by the desktop loader, and (through this
 * module) by plugin authors' own builds. Pure: no filesystem here.
 */
import { PROTOCOL_VERSION, VIEW_PERMISSIONS, type ViewPermission } from "./protocol.js";

export const MANIFEST_FILE = "hivemind-view.json";

export interface ViewManifest {
  /** Stable id: directory name, registry id, layout-blob key. `[a-z0-9-]`, 2–64 chars. */
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
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
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
  const id = str("id", 64);
  if (id !== null && !ID_RE.test(id)) errors.push(`"id" must match ${ID_RE} (got ${JSON.stringify(id)})`);
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
  let assets: string | undefined;
  if (m.assets !== undefined) {
    if (typeof m.assets !== "string" || !isSafeRelativePath(m.assets)) errors.push(`"assets" must be a relative path inside the package`);
    else assets = m.assets;
  }
  for (const k of Object.keys(m)) if (!["id", "name", "version", "entry", "protocol", "permissions", "assets"].includes(k)) errors.push(`unknown field "${k}"`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { id: id!, name: name!, version: version!, entry: entry!, protocol, permissions, ...(assets ? { assets } : {}) } };
}
