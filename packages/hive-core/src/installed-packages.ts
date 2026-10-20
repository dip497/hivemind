/**
 * The packages installed on this machine. Every plugin you add belongs to exactly one package: a
 * folder holding one plugin is a package of one. A package's files are kept as they were checked
 * in `<config>/hivemind/packages/store/<owner>--<name>/<version>-<digest>/` and never changed
 * there. `installed.json` beside the store is the record of each package: the version and digest
 * in use (which folder), whether it is on, its members by kind, id and path, and the version
 * before it. Changing it is one rename, so a reader sees the old record or the new one.
 *
 * This module only reads and writes the records; it never names a kind of plugin.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withLock } from "./settings.js";
import type { PackageOf } from "./plugin-settings.js";

/** One plugin a package holds: its kind, its id, its folder inside the package, the SHA-256 of
 *  what it is, and what it asks to be allowed. What an update is compared by. */
export interface PackageMember { kind: string; id: string; path: string; digest: string; permissions: string[] }

/** One version of a package, as it was installed. */
export interface PackageVersion {
  version: string;
  /** The SHA-256 of every file in it, as `hive packages inspect` gives it. */
  digest: string;
  name: string;
  members: PackageMember[];
}

export interface PackageRecord extends PackageVersion {
  id: string;
  /** Switched on: every member it holds can load. */
  on: boolean;
  /** The version in use before this one, and whether it was on: kept for `hive plugins rollback`. */
  previous?: PackageVersion & { on: boolean };
}

export function packagesDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "packages");
}
export const recordsFile = (): string => path.join(packagesDir(), "installed.json");

/** `@owner/name` → `owner--name`; a bare name stays itself. */
export const packageFolderName = (id: string): string => id.replace(/^@/, "").replace("/", "--");

/** Where a version of a package keeps its files. */
export function versionFolder(id: string, v: Pick<PackageVersion, "version" | "digest">): string {
  return path.join(packagesDir(), "store", packageFolderName(id), `${v.version}-${v.digest.slice(0, 12)}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 300;

function parseVersion(raw: unknown): PackageVersion | null {
  if (!isObj(raw) || !str(raw.version) || !str(raw.digest) || !/^[a-f0-9]{64}$/.test(raw.digest) || !str(raw.name) || !Array.isArray(raw.members)) return null;
  const members = raw.members.filter((m): m is PackageMember => isObj(m) && str(m.kind) && str(m.id) && typeof m.path === "string" && !m.path.split("/").includes("..")
    && typeof m.digest === "string" && Array.isArray(m.permissions) && m.permissions.every((p) => typeof p === "string"));
  return { version: raw.version, digest: raw.digest, name: raw.name, members: members.map(({ kind, id, path, digest, permissions }) => ({ kind, id, path, digest, permissions })) };
}

function parseRecords(text: string): PackageRecord[] {
  const raw = JSON.parse(text) as unknown;
  if (!isObj(raw) || !Array.isArray(raw.packages)) throw new Error("it holds no list of packages");
  const out: PackageRecord[] = [];
  for (const r of raw.packages) {
    const v = parseVersion(r);
    if (!v || !isObj(r) || !str(r.id) || /[\\]|\.\./.test(r.id)) continue;
    const previous = parseVersion(r.previous);
    out.push({ id: r.id, ...v, on: r.on === true, ...(previous ? { previous: { ...previous, on: isObj(r.previous) && r.previous.on === true } } : {}) });
  }
  return out;
}

/** Every installed package. None when nothing was ever installed; a record that cannot be read
 *  reads as none too, so a damaged file never stops the app from starting. */
export async function readInstalledPackages(): Promise<PackageRecord[]> {
  try { return parseRecords(await readFile(recordsFile(), "utf8")); } catch { return []; }
}

/** The installed members of `kind`, each with its folder and the package that owns it. */
export async function installedMembers(kind: string): Promise<Array<{ id: string; dir: string; package: PackageOf }>> {
  return (await readInstalledPackages()).flatMap((r) => r.members.filter((m) => m.kind === kind).map((m) => ({
    id: m.id, dir: path.join(versionFolder(r.id, r), m.path),
    package: { id: r.id, version: r.version, on: r.on, members: r.members.length },
  })));
}

/** The package that holds plugin `kind:id`, if one does. */
export const packageHolding = (records: readonly PackageRecord[], kind: string, id: string): PackageRecord | undefined =>
  records.find((r) => r.members.some((m) => m.kind === kind && m.id === id));

/**
 * Change the records under their lock: `change` gets them as they are on disk now and returns
 * what to write, or throws and nothing is written. A file that is there but cannot be read is
 * not written over.
 */
export async function changeInstalledPackages<T>(change: (records: PackageRecord[]) => Promise<{ records: PackageRecord[]; result: T }>): Promise<T> {
  const file = recordsFile();
  await mkdir(path.dirname(file), { recursive: true });
  return withLock(file, async () => {
    let records: PackageRecord[] = [];
    let text: string | null = null;
    try { text = await readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (text !== null) {
      try { records = parseRecords(text); } catch (e) { throw new Error(`${file} cannot be read (${e instanceof Error ? e.message : String(e)}); nothing was changed`); }
    }
    const { records: next, result } = await change(records);
    const draft = `${file}.${randomUUID()}`;
    try {
      await writeFile(draft, JSON.stringify({ packages: next }, null, 2) + "\n");
      await rename(draft, file);
    } finally { await rm(draft, { force: true }).catch(() => {}); }
    return result;
  });
}
