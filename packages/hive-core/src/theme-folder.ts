/**
 * A theme's folder on disk, read: its `theme.json` checked against the files beside it
 * (`./theme-format.ts`), and the id it has in its package, `@owner/package/<folder>`. Used by the
 * package reader (a theme member) and by applying a theme (`./theme-apply.ts`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkTheme, THEME_MANIFEST, type Theme, type ThemeFolderFile } from "./theme-format.js";

/** A theme's folder name, which is the last part of its id. */
export const THEME_FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The most files a theme's folder is read for. */
const MOST_FILES = 256;

/** The files under `dir`, by their path inside it, with their sizes. Links are not followed. */
async function filesIn(dir: string): Promise<ThemeFolderFile[]> {
  const out: ThemeFolderFile[] = [];
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 4) return;
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
  if (!packageId) throw new Error(`a theme comes in a package: name its folder in a hivemind-package.json's "themes"`);
  const folder = path.basename(path.resolve(dir));
  if (!THEME_FOLDER_RE.test(folder)) throw new Error(`a theme's folder is named like its id: lowercase letters, digits and dashes, not "${folder}"`);
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(path.join(dir, THEME_MANIFEST), "utf8")); } catch (e) {
    throw new Error(`${THEME_MANIFEST} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = checkTheme(raw, await filesIn(dir));
  if ("problem" in r) throw new Error(`${THEME_MANIFEST}: ${r.problem}`);
  return { id: `${packageId}/${folder}`, theme: r.theme };
}
