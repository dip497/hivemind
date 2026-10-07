/**
 * Tool plugins on this machine: `<config>/hivemind/tools/<owner>--<name>/`, beside the views and
 * the widgets, each a `hivemind-tool.json` and its module. The app and the CLI read, add and
 * remove them here. A folder that cannot be read is listed with what is wrong, so the person
 * sees why it does not load instead of it vanishing.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isToolId, parseToolManifest, toolFolder, type ToolPackage } from "./tool-format.js";

export const TOOL_MANIFEST = "hivemind-tool.json";

export function userToolsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "tools");
}

/** The package in `dir`. `folderId` is the id its folder stands for, if any. */
export async function readToolPackage(dir: string, folderId: string | null): Promise<ToolPackage> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(dir, TOOL_MANIFEST), "utf8")); } catch { throw new Error(`no readable ${TOOL_MANIFEST} in that folder`); }
  const pkg = parseToolManifest(raw, dir, folderId);
  if (!(await stat(path.join(dir, pkg.entry)).catch(() => null))?.isFile()) throw new Error(`its entry ${pkg.entry} is missing`);
  return pkg;
}

/** Every tool plugin installed; one that cannot be read is listed under its folder's id with why. */
export async function listToolPackages(dir = userToolsDir()): Promise<ToolPackage[]> {
  const folders = (await readdir(dir).catch(() => [] as string[])).filter((f) => !f.startsWith(".") && f.includes("--")).sort();
  return Promise.all(folders.map(async (f) => {
    const id = f.replace("--", "/");
    try {
      return await readToolPackage(path.join(dir, f), id);
    } catch (e) {
      return {
        id, name: id, description: "", tools: [], tiles: {}, permissions: [], settings: [], entry: "", apiVersion: 0, dir: path.join(dir, f),
        problem: e instanceof Error ? e.message : String(e),
      } satisfies ToolPackage;
    }
  }));
}

/** Copy the tool plugin in `src` into the tools folder, replacing one with the same id. It is
 *  checked before anything is replaced, and copied whole before it takes the old one's place.
 *  `id`, when given (a HiveHub listing), is the id its manifest must say. */
export async function installToolPackage(src: string, id?: string, dir = userToolsDir()): Promise<ToolPackage> {
  const read = await readToolPackage(src, id ?? null);
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(path.join(dir, ".install-"));
  const dest = path.join(dir, toolFolder(read.id));
  try {
    await cp(src, path.join(staging, "next"), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(path.join(staging, "next"), dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { ...read, dir: dest };
}

export async function removeToolPackage(id: string, dir = userToolsDir()): Promise<void> {
  if (!isToolId(id)) throw new Error(`${id} is not a tool plugin id`);
  const at = path.join(dir, toolFolder(id));
  if (!(await stat(at).catch(() => null))) throw new Error(id.startsWith("hivemind/") ? "it comes with the app" : `no tool plugin ${id} is installed`);
  await rm(at, { recursive: true, force: true });
}

/** A file of an installed tool plugin, by its id and the path inside its folder; null when it is
 *  not inside that folder. */
export function toolFile(id: string, rel: string, dir = userToolsDir()): string | null {
  if (!isToolId(id)) return null;
  const root = path.join(dir, toolFolder(id));
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}
