/**
 * Community view packages on disk. A view is a directory holding
 * `hivemind-view.json` (validated by @hivemind/view-sdk) plus its bundled
 * entry and assets. Three roots are scanned:
 *
 *   installed packages (./installed-packages.ts)   by `hive plugins install`
 *   <repo>/.hivemind/views/<id>/            shipped with a repo
 *   <app>/out/views/<id>/                   come with the app, which names the folder
 *
 * The desktop loader and the CLI both read through this module, so what
 * `hive plugins list --kind view` prints is exactly what the app will (or will not) load.
 * Nothing here executes plugin code.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isViewId, MANIFEST_FILE, validateViewManifest, type ViewManifest } from "@hivemind/view-sdk/manifest";
import { HiveError } from "./storage.js";
import { installedMembers } from "./installed-packages.js";
import type { PackageOf } from "./plugin-settings.js";
import { readSvgIcon } from "./svg-icon.js";

export type ViewSource = "user" | "repo" | "app";

export interface InstalledView {
  /** Directory name (the manifest id when valid). */
  id: string;
  dir: string;
  source: ViewSource;
  manifest: ViewManifest | null;
  /** The .svg its manifest names, as a data URL; none when that file is missing or too large. */
  icon?: string;
  /** Why the view will not load (null = loadable). */
  error: string | null;
  /** The package it was installed with, for one installed. */
  package?: PackageOf;
}

export function repoViewsDir(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "views");
}

/** Read + validate one package directory. Never throws: problems land in
 *  `error`. `installed` = the dir is inside a views root, so its name must be
 *  the manifest id (a source dir being installed can be called anything). */
export async function readViewPackage(dir: string, source: ViewSource, installed = true): Promise<InstalledView> {
  const id = idOfDir(dir);
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
  const icon = v.manifest.icon ? await readSvgIcon(dir, v.manifest.icon) : undefined;
  return { id: v.manifest.id, dir, source, manifest: v.manifest, ...(icon ? { icon } : {}), error: null };
}

/** The id a folder is installed as: its name, or `@owner/name` when it sits inside `@owner/`. */
const idOfDir = (dir: string) => {
  const owner = path.basename(path.dirname(dir));
  return owner.startsWith("@") ? `${owner}/${path.basename(dir)}` : path.basename(dir);
};

/** Package folders under a root: `name/`, and `@owner/name/` for what came from HiveHub. */
async function packageDirs(root: string): Promise<string[]> {
  const dirs = async (d: string) => {
    try { return (await fs.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort(); }
    catch { return []; }
  };
  const out: string[] = [];
  for (const n of await dirs(root)) {
    if (n.startsWith("@")) for (const m of await dirs(path.join(root, n))) out.push(path.join(root, n, m));
    else out.push(path.join(root, n));
  }
  return out;
}

async function scan(root: string, source: ViewSource): Promise<InstalledView[]> {
  return Promise.all((await packageDirs(root)).map((d) => readViewPackage(d, source)));
}

/** Every package in the roots: the app's own first (the order views are offered in), then yours,
 *  then the repository's. One whose id is already taken is reported with an error: yours wins
 *  over a repository's, and either over the app's, so installing a view under the id of one that
 *  comes with the app replaces it. */
export async function listInstalledViews(repoRoot?: string | null, appRoot?: string | null): Promise<InstalledView[]> {
  const user = await Promise.all((await installedMembers("view")).map(async (m) => {
    const v = await readViewPackage(m.dir, "user", false);
    return { ...v, ...(v.error || v.id === m.id ? {} : { error: `its manifest says it is "${v.id}", not "${m.id}"` }), id: m.id, package: m.package };
  }));
  const repo = repoRoot ? await scan(repoViewsDir(repoRoot), "repo") : [];
  const own = appRoot ? await scan(appRoot, "app") : [];
  const taken = new Set(user.filter((v) => !v.error).map((v) => v.id));
  for (const v of repo) if (!v.error && taken.has(v.id)) v.error = `shadowed by the user-installed view "${v.id}"`;
  for (const v of repo) if (!v.error) taken.add(v.id);
  for (const v of own) if (!v.error && taken.has(v.id)) v.error = `replaced by the installed view "${v.id}"`;
  return [...own, ...user, ...repo];
}

/** The view in `dir`, checked for installing. */
export async function viewToInstall(dir: string): Promise<InstalledView> {
  const pkg = await readViewPackage(dir, "user", false);
  if (pkg.error) throw new HiveError("invalid_view", pkg.error);
  // "world" is still reserved though that view is gone: a saved workspace may name it.
  if (["canvas", "windows", "world"].includes(pkg.id)) throw new HiveError("invalid_view", `${pkg.id} is the id of a view that comes with the app`);
  return pkg;
}
