/**
 * A package's live wallpapers on disk: a member's folder read (`./wallpaper-format.ts` checks what
 * it holds), and every installed one, for the app to list and serve and the CLI to name. Nothing
 * here runs a wallpaper's code: the app runs it in a sandboxed frame.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateWallpaperManifest, WALLPAPER_MANIFEST, type WallpaperManifest } from "@hivemind/view-sdk/wallpaper";
import { installedMembers } from "./installed-packages.js";
import type { PackageOf } from "./plugin-settings.js";
import { resolvePackageFile } from "./view-files.js";
import { readWallpaper, type WallpaperFolderFile } from "./wallpaper-format.js";

/** The wallpaper in `dir`, a member of package `packageId`: its id and what its manifest says.
 *  Throws why not. Its entry and preview count as there only inside its folder, through any link:
 *  the app serves nothing from outside it. */
export async function readWallpaperFolder(dir: string, packageId: string | undefined): Promise<{ id: string; manifest: WallpaperManifest }> {
  const json = await fs.readFile(path.join(dir, WALLPAPER_MANIFEST), "utf8").catch(() => null);
  const files: WallpaperFolderFile[] = [];
  if (json !== null) {
    let named: string[] = [];
    try {
      const v = validateWallpaperManifest(JSON.parse(json));
      if (v.ok) named = [v.manifest.entry, ...(v.manifest.preview ? [v.manifest.preview] : [])];
    } catch { /* readWallpaper says why */ }
    for (const rel of named) {
      const at = resolvePackageFile(dir, rel);
      if (at.status === 200) files.push({ path: rel, bytes: (await fs.stat(at.abs)).size });
    }
  }
  const r = readWallpaper(path.basename(path.resolve(dir)), packageId, json, files);
  if ("problem" in r) throw new Error(r.problem);
  return r;
}

/** An installed live wallpaper: its folder, what its manifest says, and the package it came in;
 *  or why it cannot be used. */
export interface InstalledWallpaper {
  id: string;
  dir: string;
  package: PackageOf;
  manifest: WallpaperManifest | null;
  error: string | null;
}

/** Every live wallpaper the installed packages hold, the ones that cannot be read with why. */
export async function listInstalledWallpapers(): Promise<InstalledWallpaper[]> {
  return Promise.all((await installedMembers("wallpaper")).map(async (m) => {
    try {
      const { manifest } = await readWallpaperFolder(m.dir, m.package.id);
      return { id: m.id, dir: m.dir, package: m.package, manifest, error: null };
    } catch (e) {
      return { id: m.id, dir: m.dir, package: m.package, manifest: null, error: e instanceof Error ? e.message : String(e) };
    }
  }));
}
