/**
 * Installing, removing and switching packages: the one way a plugin you add gets onto this
 * machine, and off it. A package is a folder with a `hivemind-package.json` naming its members; a
 * folder holding one plugin is a package of one. Each member belongs to one package only.
 *
 * An install copies the folder into a private staging folder, checks every member there (never
 * the folder it came from, which can change meanwhile), moves the copy into the store, and only
 * then writes the record. Until that last rename nothing the app reads has changed, so an install
 * that fails or is cut off leaves the version that was in use.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { copyPackage, folderDigest, readPackage, type PackageRead } from "./packages.js";
import { memberKind, type CheckedMember } from "./package-kinds.js";
import {
  changeInstalledPackages, packageFolderName, packageHolding, packagesDir, readInstalledPackages, versionFolder,
  type PackageMember, type PackageRecord, type PackageVersion,
} from "./installed-packages.js";
import { updateSettings } from "./settings.js";
import { HiveError } from "./storage.js";
import { pluginKey, type PluginKind } from "./plugin-settings.js";

/** A member as installed: where it is, and what its kind read from it. */
export interface InstalledMember extends Omit<CheckedMember, "digest">, PackageMember { dir: string }

export interface InstalledPackage {
  record: PackageRecord;
  members: InstalledMember[];
  /** The version it replaced, if one was installed. */
  replaced: PackageVersion | null;
  /** The plugins installed on their own that it took over (`replaces`), their settings kept. */
  tookOver: string[];
  /** How each member differs from the version before it; empty for the same files again. */
  changes: MemberChange[];
}

/** Refused because a package holds it: one of its plugins cannot be installed, removed or switched
 *  on apart from it. */
export class PartOfPackageError extends HiveError {
  constructor(message: string, readonly packageId: string) {
    super("part_of_a_package", message);
  }
}

const nounOf = (kind: string): string => memberKind(kind)?.noun ?? kind;

const versionOf = (r: PackageVersion): PackageVersion => ({ version: r.version, digest: r.digest, name: r.name, members: r.members });

/** Every version folder of a package but the ones its record names now. Run after the record is
 *  written, so a folder goes only once nothing names it. */
async function pruneStore(id: string): Promise<void> {
  const root = path.join(packagesDir(), "store", packageFolderName(id));
  const r = (await readInstalledPackages()).find((x) => x.id === id);
  const wanted = new Set([r, r?.previous].flatMap((v) => (v ? [path.basename(versionFolder(id, v))] : [])));
  for (const f of await readdir(root).catch(() => [] as string[])) if (!wanted.has(f)) await rm(path.join(root, f), { recursive: true, force: true });
  if (!wanted.size) await rm(root, { recursive: true, force: true });
}

/** How one member differs from the version before it, and whether that needs the person again. */
export interface MemberChange {
  kind: string;
  id: string;
  /** `new`: the version before had no such member; `gone`: this version drops it; `changed`: its
   *  files (a preset's prompt) or what it asks for changed. */
  change: "new" | "gone" | "changed";
  /** What it asks for that it did not before. */
  newPermissions: string[];
  /** This change switches the package off: a sandboxed member asks for more, or code that runs in
   *  the app or an agent's instructions is new or changed. */
  switchesOff: boolean;
}

/** What installing `read` over `records` would do: the record it writes, what it takes over, and
 *  how each member changed. Nothing is written. */
function plan(records: readonly PackageRecord[], read: PackageRead, version: PackageVersion) {
  const old = records.find((r) => r.id === read.id);
  // What it takes over: plugins of its owner installed on their own, each a package of one.
  const taken = records.filter((r) => read.replaces.includes(r.id) && r.id !== read.id);
  for (const t of taken) {
    if (t.members.length !== 1 || t.members[0]!.id !== t.id) throw new PartOfPackageError(`${read.id} replaces ${t.id}, but ${t.id} is a package of ${t.members.length}, not a plugin installed on its own: remove ${t.id} first`, t.id);
  }
  refuseHeld(records, read.id, version.members, taken);
  const before = [...(old?.members ?? []), ...taken.flatMap((t) => t.members)];
  const changes: MemberChange[] = [];
  for (const m of version.members) {
    const o = before.find((x) => x.kind === m.kind && x.id === m.id);
    const newPermissions = m.permissions.filter((p) => !(o?.permissions ?? []).includes(p));
    if (o && o.digest === m.digest && !newPermissions.length) continue;
    const sandboxed = memberKind(m.kind)?.runs === "sandboxed";
    changes.push({ kind: m.kind, id: m.id, change: o ? "changed" : "new", newPermissions, switchesOff: sandboxed ? newPermissions.length > 0 : true });
  }
  for (const o of before) if (!version.members.some((m) => m.kind === o.kind && m.id === o.id)) changes.push({ kind: o.kind, id: o.id, change: "gone", newPermissions: [], switchesOff: false });
  const wasOn = old ? old.on : taken.length ? taken.every((t) => t.on) : null;
  const on = wasOn === null ? version.members.every((m) => memberKind(m.kind)?.runs === "sandboxed") : wasOn && !changes.some((c) => c.switchesOff);
  const same = old?.digest === version.digest;
  const record: PackageRecord = {
    id: read.id, ...version, on,
    ...(old && !same ? { previous: { ...versionOf(old), on: old.on } } : old?.previous ? { previous: old.previous } : {}),
  };
  return { old, taken, changes, record };
}

/** Refuse members another package holds, unless it is one being taken over. */
function refuseHeld(records: readonly PackageRecord[], id: string, members: readonly PackageMember[], taken: readonly PackageRecord[] = []): void {
  for (const m of members) {
    const owner = packageHolding(records, m.kind, m.id);
    if (!owner || owner.id === id || taken.includes(owner)) continue;
    throw new PartOfPackageError(owner.members.length > 1
      ? `${nounOf(m.kind)} ${m.id} is part of the package ${owner.id}: install ${owner.id} again to update it, or remove ${owner.id} first`
      : `${nounOf(m.kind)} ${m.id} is installed on its own: add "replaces": ["${owner.id}"] to ${id}'s hivemind-package.json to take it over, or remove it first`, owner.id);
  }
}

/**
 * Install the package in `src`, or update the one installed with its id. `id`, when given, is the
 * id it must have (the HiveHub listing it came from).
 *
 * A new package is on when every member is sandboxed (views, widgets). An update keeps its switch
 * unless a member needs the person again: a view or widget that asks for a permission it did not
 * have, or a tool or agent preset that is new or changed. The version it replaces is kept for
 * `rollbackPackage`. With `dryRun` everything is checked and the changes are given, and nothing
 * is installed.
 */
/** What a review saw, for an install to hold it to: the files' digest, the version it replaced
 *  (null for none) and whether it would be on. */
export interface Reviewed { digest: string; replacing: string | null; on: boolean }

/** What a dry run's result commits an install to. */
export const reviewedOf = (r: InstalledPackage): Reviewed => ({ digest: r.record.digest, replacing: r.replaced?.digest ?? null, on: r.record.on });

export async function installPackage(src: string, given: { id?: string; dryRun?: boolean; reviewed?: Reviewed } = {}): Promise<InstalledPackage> {
  const from = path.resolve(src);
  if (!(await stat(from).catch(() => null))?.isDirectory()) throw new Error(`there is no folder ${from}`);
  await mkdir(packagesDir(), { recursive: true });
  const staging = await mkdtemp(path.join(packagesDir(), ".staging-"));
  try {
    const files = path.join(staging, "files");
    const copied = await copyPackage(from, files);
    // The copy is what gets installed, so it is the copy that must be what was reviewed.
    if (given.reviewed && copied.digest !== given.reviewed.digest) throw new Error("its files changed after the review: review it again");
    const read = await readPackage(files, { ...(given.id ? { id: given.id } : {}), folder: path.basename(from) });
    const version: PackageVersion = {
      version: read.version, digest: copied.digest, name: read.name,
      members: read.members.map(({ kind, id, path: p, permissions, digest }) => ({ kind, id, path: p, permissions, digest: digest ?? folderDigest(copied.files, p) })),
    };
    const dest = versionFolder(read.id, version);
    const result = (p: ReturnType<typeof plan>, dir: string) => ({
      record: p.record, members: read.members.map((m, i) => ({ ...m, digest: version.members[i]!.digest, dir: path.join(dir, m.path) })),
      replaced: p.old ? versionOf(p.old) : null, tookOver: p.taken.map((t) => t.id), changes: p.changes,
    });
    if (given.dryRun) return result(plan(await readInstalledPackages(), read, version), files);
    const installed = await changeInstalledPackages(async (records) => {
      const p = plan(records, read, version);
      if (given.reviewed && ((p.old?.digest ?? null) !== given.reviewed.replacing || p.record.on !== given.reviewed.on)) {
        throw new Error(`${read.id} changed after the review: review it again`);
      }
      if (!existsSync(dest)) {
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(files, dest);
      }
      return { records: [...records.filter((r) => r.id !== read.id && !p.taken.includes(r)), p.record], result: result(p, dest) };
    });
    for (const t of [read.id, ...installed.tookOver]) await pruneStore(t);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Put back the version of package `id` that was in use before this one, switched as it was then.
 *  The one it replaces is kept in its place, so a second rollback undoes the first. */
export async function rollbackPackage(id: string): Promise<{ record: PackageRecord; from: PackageVersion }> {
  return changeInstalledPackages(async (records) => {
    const r = records.find((x) => x.id === id);
    if (!r) throw new Error(`no package ${id} is installed`);
    if (!r.previous) throw new Error(`${id} ${r.version} is the only version installed: there is none before it to go back to`);
    const { on, ...back } = r.previous;
    if (!existsSync(versionFolder(id, back))) throw new Error(`the files of ${id} ${back.version} are gone; nothing was changed`);
    refuseHeld(records, id, back.members);
    const record: PackageRecord = { id, ...back, on, previous: { ...versionOf(r), on: r.on } };
    return { records: records.map((x) => (x === r ? record : x)), result: { record, from: versionOf(r) } };
  });
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

/** Remove plugin `kind:id`, installed on its own: its package of one. One that is part of a
 *  bigger package is removed only with it. */
export async function removePlugin(kind: PluginKind, id: string): Promise<PackageRecord> {
  const r = packageHolding(await readInstalledPackages(), kind, id);
  if (!r) throw new Error(`no ${nounOf(kind)} ${id} is installed`);
  if (r.members.length > 1) throw new PartOfPackageError(`${nounOf(kind)} ${id} is part of the package ${r.id}: remove the whole package with \`hive plugins remove ${r.id}\``, r.id);
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
 * setting. A package of one is switched as a whole. One of a bigger package can be switched off
 * on its own, and on again only while its package is on.
 */
export async function switchPlugin(kind: PluginKind, id: string, on: boolean): Promise<PackageRecord | null> {
  const r = packageHolding(await readInstalledPackages(), kind, id);
  if (!r) return null;
  const alone = r.members.length === 1;
  if (!alone && on && !r.on) throw new PartOfPackageError(`${nounOf(kind)} ${id} is part of the package ${r.id}, which is off: switch the package on with \`hive plugins enable ${r.id}\``, r.id);
  const key = pluginKey(kind, id);
  // On: nothing of its own keeps it off. Off, in a bigger package: off on its own.
  await updateSettings((cur) => {
    const { [key]: state, ...rest } = cur.plugins.state;
    const { enabled: _, ...kept } = state ?? {};
    const next = !alone && !on ? { ...kept, enabled: false } : kept;
    if (JSON.stringify(next) === JSON.stringify(state ?? {})) return cur;
    return { ...cur, plugins: { ...cur.plugins, state: Object.keys(next).length ? { ...rest, [key]: next } : rest } };
  });
  return alone ? switchPackage(r.id, on) : r;
}
