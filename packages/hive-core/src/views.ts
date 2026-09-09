/**
 * Community view packages on disk. A view is a directory holding
 * `hivemind-view.json` (validated by @hivemind/view-sdk) plus its bundled
 * entry and assets. Two roots are scanned:
 *
 *   $XDG_CONFIG_HOME/hivemind/views/<id>/   installed by `hive views install`
 *   <repo>/.hivemind/views/<id>/            shipped with a repo
 *
 * The desktop loader and the CLI both read through this module, so what
 * `hive views list` prints is exactly what the app will (or will not) load.
 * Nothing here executes plugin code.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MANIFEST_FILE, validateViewManifest, type ViewManifest } from "@hivemind/view-sdk/manifest";
import { HiveError } from "./storage.js";

export type ViewSource = "user" | "repo";

export interface InstalledView {
  /** Directory name (the manifest id when valid). */
  id: string;
  dir: string;
  source: ViewSource;
  manifest: ViewManifest | null;
  /** Why the view will not load (null = loadable). */
  error: string | null;
}

export function userViewsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "views");
}

export function repoViewsDir(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "views");
}

/** Read + validate one package directory. Never throws: problems land in
 *  `error`. `installed` = the dir is inside a views root, so its name must be
 *  the manifest id (a source dir being installed can be called anything). */
export async function readViewPackage(dir: string, source: ViewSource, installed = true): Promise<InstalledView> {
  const id = path.basename(dir);
  const fail = (error: string): InstalledView => ({ id, dir, source, manifest: null, error });
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8"));
  } catch (e) {
    return fail(`cannot read ${MANIFEST_FILE}: ${(e as Error).message}`);
  }
  const v = validateViewManifest(raw);
  if (!v.ok) return fail(`invalid ${MANIFEST_FILE}: ${v.errors.join("; ")}`);
  if (installed && v.manifest.id !== id) return fail(`directory "${id}" does not match manifest id "${v.manifest.id}"`);
  try {
    const st = await fs.stat(path.join(dir, v.manifest.entry));
    if (!st.isFile()) return fail(`entry "${v.manifest.entry}" is not a file`);
  } catch {
    return fail(`entry "${v.manifest.entry}" not found`);
  }
  return { id: v.manifest.id, dir, source, manifest: v.manifest, error: null };
}

async function scan(root: string, source: ViewSource): Promise<InstalledView[]> {
  let names: string[];
  try { names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort(); }
  catch { return []; }
  return Promise.all(names.map((n) => readViewPackage(path.join(root, n), source)));
}

/** Every package in both roots, user dir first. A repo package whose id a user
 *  package already uses is reported with an error (the user's wins). */
export async function listInstalledViews(repoRoot?: string | null): Promise<InstalledView[]> {
  const user = await scan(userViewsDir(), "user");
  const repo = repoRoot ? await scan(repoViewsDir(repoRoot), "repo") : [];
  const taken = new Set(user.filter((v) => !v.error).map((v) => v.id));
  for (const v of repo) if (!v.error && taken.has(v.id)) v.error = `shadowed by the user-installed view "${v.id}"`;
  return [...user, ...repo];
}

/** Validate `srcDir` and copy it to the user views dir (replacing any previous install). */
export async function installView(srcDir: string): Promise<InstalledView> {
  const src = path.resolve(srcDir);
  const pkg = await readViewPackage(src, "user", false);
  if (pkg.error) throw new HiveError("invalid_view", pkg.error);
  const dest = path.join(userViewsDir(), pkg.id);
  if (path.resolve(dest) === src) throw new HiveError("invalid_view", `"${src}" is already the installed copy`);
  await fs.mkdir(userViewsDir(), { recursive: true });
  // Copy and validate before moving the installed version: a missing asset or
  // failed copy must not destroy a working extension (desktop and CLI share this).
  const staging = await fs.mkdtemp(path.join(userViewsDir(), ".install-"));
  const next = path.join(staging, "next");
  const backup = path.join(staging, "previous");
  let keepBackup = false;
  try {
    await fs.cp(src, next, { recursive: true, dereference: true, filter: (p) => path.basename(p) !== "node_modules" });
    const copied = await readViewPackage(next, "user", false);
    if (copied.error || copied.id !== pkg.id) throw new HiveError("invalid_view", copied.error ?? "package changed during installation");
    let replaced = false;
    try { await fs.rename(dest, backup); replaced = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    try { await fs.rename(next, dest); }
    catch (e) {
      if (replaced) {
        keepBackup = true;
        await fs.rename(backup, dest);
        keepBackup = false;
      }
      throw e;
    }
    return readViewPackage(dest, "user");
  } finally {
    // If restoring failed, retain the previous files for recovery.
    if (!keepBackup) await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Remove a user-installed view. Its layout blobs in the app are left alone (inert). */
export async function removeView(id: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new HiveError("invalid_view", `"${id}" is not a view id`);
  const dir = path.join(userViewsDir(), id);
  try { await fs.access(dir); } catch { throw new HiveError("not_found", `no user-installed view "${id}" (${dir})`); }
  await fs.rm(dir, { recursive: true, force: true });
}
