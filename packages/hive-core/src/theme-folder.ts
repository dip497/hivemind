/**
 * A theme's folder on disk, read: its files listed and handed to `readTheme`
 * (`./theme-format.ts`), which HiveHub runs on the same parts. Used by the package reader (a
 * theme member) and by applying a theme (`./theme-apply.ts`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readTheme, THEME_DEPTH, THEME_MANIFEST, type Theme, type ThemeFolderFile } from "./theme-format.js";

/** The most files a theme's folder is read for. */
const MOST_FILES = 256;

/** The files under `dir`, by their path inside it, with their sizes, as deep as a theme may name
 *  one (`THEME_DEPTH`). Links are not followed. */
async function filesIn(dir: string): Promise<ThemeFolderFile[]> {
  const out: ThemeFolderFile[] = [];
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > THEME_DEPTH) return;
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(at, depth + 1);
      else if (e.isFile()) out.push({ path: at, bytes: (await fs.lstat(path.join(dir, at))).size });
      if (out.length >= MOST_FILES) return;
    }
  }
  await walk("", 0);
  return out;
}

/** The theme in `dir`, a member of package `packageId`: its id and what it says. Throws why not. */
export async function readThemeFolder(dir: string, packageId: string | undefined): Promise<{ id: string; theme: Theme }> {
  const folder = path.basename(path.resolve(dir));
  const json = packageId ? await fs.readFile(path.join(dir, THEME_MANIFEST), "utf8").catch(() => null) : null;
  const r = readTheme(folder, packageId, json, packageId && json !== null ? await filesIn(dir) : []);
  if ("problem" in r) throw new Error(r.problem);
  return r;
}
