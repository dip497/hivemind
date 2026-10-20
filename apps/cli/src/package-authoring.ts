/** Writing a package: its starter, and its members added to `hivemind-package.json`, each in a
 *  folder of its own inside it. Which kinds it can hold, and how each is read, are the package
 *  format's (`@hivemind/core/package-format`, `package-kinds`); this names no kind. */
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMBER_FORMATS, MEMBER_ID, memberFormat, PACKAGE_MANIFEST } from "@hivemind/core/package-format";
import { memberKind } from "@hivemind/core/package-kinds";
import type { AuthoredKind } from "./plugin-kinds.js";
import { packageBrief } from "./plugin-brief.js";

const title = (name: string) => name.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** What `hive plugins new package` writes: a manifest that holds no member yet, a README and the
 *  brief for an agent. */
export function packageStarter(owner: string, name: string): Record<string, string> {
  const id = `@${owner}/${name}`;
  const manifest = { apiVersion: 2, id, name: title(name), version: "0.1.0", ...Object.fromEntries(MEMBER_FORMATS.map((f) => [f.list, []])) };
  return {
    [PACKAGE_MANIFEST]: JSON.stringify(manifest, null, 2) + "\n",
    "README.md": `# ${title(name)}\n\nWhat it holds, in one line. Shown on its HiveHub page and in the app before anyone installs it: say what each member does and what it asks for.\n\nGuide: https://hivemind.griiken.com/guide/packages/\n`,
    "PROMPT.md": packageBrief(id),
    ".gitignore": "node_modules/\n",
  };
}

/** A package's folder as written so far: its manifest as JSON, its id and its owner. Read without
 *  the full check, so a package that holds nothing yet can be added to. */
export interface PackageFolder { dir: string; manifest: Record<string, unknown>; id: string; owner: string }

export async function readPackageFolder(given: string): Promise<PackageFolder> {
  const dir = path.resolve(given);
  const file = path.join(dir, PACKAGE_MANIFEST);
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; } catch (e) {
    throw new Error(fs.existsSync(file) ? `${file} is not JSON: ${e instanceof Error ? e.message : String(e)}` : `${dir} holds no ${PACKAGE_MANIFEST}: start one with \`hive plugins new package <name>\``);
  }
  const id = manifest.id;
  if (typeof id !== "string" || !MEMBER_ID.test(id)) throw new Error(`the id in ${file} is not @owner/name`);
  return { dir, manifest, id, owner: id.slice(1, id.indexOf("/")) };
}

/** Where a member in `dir` is named from its package: its built folder when it builds one. */
export const memberPath = (pkg: PackageFolder, k: AuthoredKind, dir: string): string => {
  const rel = path.relative(pkg.dir, dir).split(path.sep).join("/") || ".";
  return k.builtIn && fs.existsSync(path.join(dir, "package.json")) ? `${rel}/${k.builtIn}` : rel;
};

/** The folder a member's own check runs in: the one its entry names, or the one that builds it. */
export const sourceOf = (k: AuthoredKind, full: string): string =>
  k.builtIn && path.basename(full) === k.builtIn && fs.existsSync(path.join(path.dirname(full), "package.json")) ? path.dirname(full) : full;

/** The id the plugin in `dir` installs as, read as an install reads it. */
export async function memberId(k: AuthoredKind, dir: string): Promise<string> {
  const built = k.builtIn ? path.join(dir, k.builtIn) : null;
  const at = built && fs.existsSync(path.join(built, k.manifest)) ? built : dir;
  const read = await memberKind(k.kind)!.check(path.dirname(at), { path: path.basename(at) }, { folder: path.basename(at) });
  return read.id;
}

/** Name the member at `entryPath` in the package's manifest, under its kind's list. */
export async function addEntry(pkg: PackageFolder, k: AuthoredKind, entryPath: string): Promise<void> {
  const list = memberFormat(k.kind)!.list;
  const was = Array.isArray(pkg.manifest[list]) ? (pkg.manifest[list] as Array<{ path?: string }>) : [];
  if (was.some((e) => e.path === entryPath)) throw new Error(`${PACKAGE_MANIFEST} already names ${entryPath}`);
  pkg.manifest[list] = [...was, { path: entryPath }];
  await writeFile(path.join(pkg.dir, PACKAGE_MANIFEST), JSON.stringify(pkg.manifest, null, 2) + "\n");
}

/** Whether installing it needs the person to switch it on: it holds a member that is not sandboxed. */
export const arrivesOff = (pkg: PackageFolder): boolean =>
  MEMBER_FORMATS.some((f) => f.runs !== "sandboxed" && Array.isArray(pkg.manifest[f.list]) && (pkg.manifest[f.list] as unknown[]).length > 0);
