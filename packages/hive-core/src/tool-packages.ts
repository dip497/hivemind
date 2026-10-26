/**
 * Tool plugins on this machine: the app's own (in a folder the app names), and those of
 * installed packages (`./installed-packages.ts`), each a `hivemind-tool.json` and its module. The
 * app and the CLI read them here. One that cannot be read is listed with what is wrong, so the
 * person sees why it does not load instead of it vanishing.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseToolManifest, toolOfFolder, type ToolPackage } from "./tool-format.js";
import { installedMembers } from "./installed-packages.js";
import { readSvgIcon } from "./svg-icon.js";
import { skillProblem } from "./plugin-skills.js";

export { TOOL_MANIFEST } from "./tool-format.js";
import { TOOL_MANIFEST } from "./tool-format.js";

/** The package in `dir`. `folderId` is the id its folder stands for, if any. */
export async function readToolPackage(dir: string, folderId: string | null, source: "app" | "you" = "you"): Promise<ToolPackage> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(dir, TOOL_MANIFEST), "utf8")); } catch { throw new Error(`no readable ${TOOL_MANIFEST} in that folder`); }
  const pkg = parseToolManifest(raw, dir, folderId, source);
  if (!(await stat(path.join(dir, pkg.entry)).catch(() => null))?.isFile()) throw new Error(`its entry ${pkg.entry} is missing`);
  for (const rel of pkg.skills ?? []) {
    const problem = await skillProblem(dir, rel);
    if (problem) throw new Error(problem);
  }
  for (const tile of Object.values(pkg.tiles)) {
    if (!tile.icon) continue;
    const icon = await readSvgIcon(dir, tile.icon);
    if (icon) tile.icon = icon;
    else delete tile.icon;
  }
  return pkg;
}

const unreadable = (id: string, dir: string, source: "app" | "you", e: unknown): ToolPackage => ({
  id, source, name: id, description: "", tools: [], tiles: {}, permissions: [], category: "other", pluginCommands: [], settings: [], entry: "", apiVersion: 0,
  dir, problem: e instanceof Error ? e.message : String(e),
});

/** Every tool plugin: the app's own (in `appRoot`, which the app names) first, then those of
 *  installed packages. One that cannot be read is listed under its id with why. */
export async function listToolPackages(appRoot?: string | null): Promise<ToolPackage[]> {
  const own = appRoot ? (await readdir(appRoot).catch(() => [] as string[])).filter((f) => !f.startsWith(".") && f.includes("--")).sort() : [];
  const app = await Promise.all(own.map((f) => readToolPackage(path.join(appRoot!, f), toolOfFolder(f), "app").catch((e: unknown) => unreadable(toolOfFolder(f), path.join(appRoot!, f), "app", e))));
  const added = await Promise.all((await installedMembers("tool")).map(async (m) => ({
    ...(await readToolPackage(m.dir, m.id).catch((e: unknown) => unreadable(m.id, m.dir, "you", e))), package: m.package,
  })));
  return [...app, ...added];
}

/** A file of a tool plugin, by the plugin's folder and the path inside it; null when it is not
 *  inside that folder. */
export function toolFile(dir: string, rel: string): string | null {
  const file = path.resolve(dir, rel);
  return file.startsWith(path.resolve(dir) + path.sep) ? file : null;
}
