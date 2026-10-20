/**
 * Installing, removing and switching packages: the one way a plugin you add gets onto this
 * machine, and off it. A folder holding one plugin is a package of one.
 *
 * An install copies the folder into a private staging folder, checks every member there (never
 * the folder it came from, which can change meanwhile), moves the copy into the store, and only
 * then writes the record. Until that last rename nothing the app reads has changed, so an install
 * that fails or is cut off leaves the version that was in use.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { copyPackage } from "./packages.js";
import { MEMBER_KINDS, memberKind, type CheckedMember } from "./package-kinds.js";
import {
  changeInstalledPackages, packageFolderName, packageHolding, packagesDir, readInstalledPackages, versionFolder,
  type PackageMember, type PackageRecord, type PackageVersion,
} from "./installed-packages.js";
import { updateSettings } from "./settings.js";
import { pluginKey, type PluginKind } from "./plugin-settings.js";

/** A member as installed: where it is, and what its kind read from it. */
export interface InstalledMember extends PackageMember, CheckedMember { dir: string }

export interface InstalledPackage {
  record: PackageRecord;
  members: InstalledMember[];
  /** The version it replaced, if one was installed. */
  replaced: PackageVersion | null;
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** What a checked copy holds: a package of one plugin, found by its kind's manifest. */
async function readPackageFolder(dir: string, given: { id?: string; folder: string }) {
  const k = MEMBER_KINDS.find((x) => existsSync(path.join(dir, x.manifest)));
  if (!k) throw new Error(`it holds no ${MEMBER_KINDS.map((x) => x.manifest).join(", ")}`);
  const m = await k.check(dir, given);
  return {
    id: m.id, name: m.name, version: m.version && VERSION.test(m.version) ? m.version : "0.0.0",
    members: [{ ...m, kind: k.kind, path: "." }],
  };
}

const versionOf = (r: PackageVersion): PackageVersion => ({ version: r.version, digest: r.digest, name: r.name, members: r.members });

/** Every version folder of a package but the ones its record names now. Run after the record is
 *  written, so a folder goes only once nothing names it. */
async function pruneStore(id: string): Promise<void> {
  const root = path.join(packagesDir(), "store", packageFolderName(id));
  const r = (await readInstalledPackages()).find((x) => x.id === id);
  const wanted = new Set((r ? [r, r.previous] : []).filter((v): v is PackageVersion => !!v).map((v) => path.basename(versionFolder(id, v))));
  for (const f of await readdir(root).catch(() => [] as string[])) if (!wanted.has(f)) await rm(path.join(root, f), { recursive: true, force: true });
  if (!wanted.size) await rm(root, { recursive: true, force: true });
}

/**
 * Install the package in `src`, or update the one installed with its id. `id`, when given, is the
 * id it must have (the HiveHub listing it came from). A package that is new is on unless it holds
 * code that runs in the app; an update of the same files keeps its switch, and one that changes
 * them goes off if it holds such code.
 */
export async function installPackage(src: string, given: { id?: string } = {}): Promise<InstalledPackage> {
  const from = path.resolve(src);
  if (!(await stat(from).catch(() => null))?.isDirectory()) throw new Error(`there is no folder ${from}`);
  await mkdir(packagesDir(), { recursive: true });
  const staging = await mkdtemp(path.join(packagesDir(), ".staging-"));
  try {
    const files = path.join(staging, "files");
    const { digest } = await copyPackage(from, files);
    const read = await readPackageFolder(files, { ...given, folder: path.basename(from) });
    const next: PackageVersion = { version: read.version, digest, name: read.name, members: read.members.map(({ kind, id, path: p }) => ({ kind, id, path: p })) };
    const dest = versionFolder(read.id, next);
    const installed = await changeInstalledPackages(async (records) => {
      const old = records.find((r) => r.id === read.id);
      if (!existsSync(dest)) {
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(files, dest);
      }
      const same = old?.digest === digest;
      const trusted = read.members.every((m) => memberKind(m.kind)?.onByDefault);
      const record: PackageRecord = {
        id: read.id, ...next,
        on: old ? old.on && (same || trusted) : trusted,
        ...(old && !same ? { previous: versionOf(old) } : old?.previous ? { previous: old.previous } : {}),
      };
      return {
        records: [...records.filter((r) => r.id !== read.id), record],
        result: { record, members: read.members.map((m) => ({ ...m, dir: path.join(dest, m.path) })), replaced: old ? versionOf(old) : null },
      };
    });
    await pruneStore(read.id);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Remove an installed package and every plugin it holds. What the person set them to stays in
 *  settings, so installing it again finds it. */
export async function removePackage(id: string): Promise<PackageRecord> {
  const gone = await changeInstalledPackages(async (records) => {
    const r = records.find((x) => x.id === id);
    if (!r) throw new Error(`no package ${id} is installed`);
    return { records: records.filter((x) => x !== r), result: r };
  });
  await pruneStore(id);
  return gone;
}

/** Remove the package that holds plugin `kind:id`. */
export async function removePlugin(kind: PluginKind, id: string): Promise<PackageRecord> {
  const r = packageHolding(await readInstalledPackages(), kind, id);
  if (!r) throw new Error(`no ${memberKind(kind)?.noun ?? kind} ${id} is installed`);
  return removePackage(r.id);
}

/** Switch a package on or off. */
export async function switchPackage(id: string, on: boolean): Promise<PackageRecord> {
  return changeInstalledPackages(async (records) => {
    const r = records.find((x) => x.id === id);
    if (!r) throw new Error(`no package ${id} is installed`);
    const next = { ...r, on };
    return { records: records.map((x) => (x === r ? next : x)), result: next };
  });
}

/**
 * Switch plugin `kind:id` on or off, when an installed package holds it, and give that package;
 * null when none does (one that comes with the app, or a repository's), whose switch is its own
 * setting. A package of one is switched as a whole.
 */
export async function switchPlugin(kind: PluginKind, id: string, on: boolean): Promise<PackageRecord | null> {
  const r = packageHolding(await readInstalledPackages(), kind, id);
  if (!r) return null;
  const key = pluginKey(kind, id);
  // Its own switch is the package's: one left off from before would keep it off for good.
  await updateSettings((cur) => {
    const { [key]: state, ...rest } = cur.plugins.state;
    if (!state || state.enabled === undefined) return cur;
    const { enabled: _, ...kept } = state;
    return { ...cur, plugins: { ...cur.plugins, state: Object.keys(kept).length ? { ...rest, [key]: kept } : rest } };
  });
  return switchPackage(r.id, on);
}
