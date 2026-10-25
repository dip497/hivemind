/**
 * Moves the data on this machine forward to the shape this build reads, once per data root:
 * every migration of `./list.ts` not yet in the root's ledger, in order. The app, the `hive` CLI
 * and `hive host` run it before they touch a root; a lock under the root lets one process at a
 * time do it, and the others wait for it and then find nothing left to do.
 *
 * Forward only. Before a migration runs, the paths it says it touches are copied into
 * `<root>/migrations/backups/<id>/`, once; `restoreMigration` puts them back. A migration is safe
 * to run again: its ledger entry is written last, so one cut off runs again on the next start.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { appData, configDir } from "../app-data.js";
import { holdLock, SettingsLockError } from "../settings.js";
import { migrationsFolder, readLedger, writeLedger, type AppliedMigration, type Ledger, type MigrationRunner } from "./ledger.js";
import { MIGRATIONS } from "./list.js";

export type DataRootName = "config" | "data";

export interface MigrationContext {
  /** The data root it changes. */
  root: string;
  /** Remove one of the paths it backs up: its copy is already in the backup. */
  remove(relative: string): Promise<void>;
}

export interface Migration {
  /** `NNNN-what-it-does`; the number gives the order. */
  id: string;
  root: DataRootName;
  /** The paths under the root it changes or removes, copied into its backup before it runs. */
  backsUp: readonly string[];
  /** Whether it changes anything on this machine; false: it is recorded as run, with no backup, so
   *  restoring it puts nothing back over what changed since. A backup a run cut off earlier made
   *  is kept whatever this says. Always when absent. */
  changesHere?(ctx: Pick<MigrationContext, "root">): Promise<boolean>;
  /** It moves files that an older app, still running, reads: the CLI and `hive host` leave it
   *  until no older app runs. */
  movesFilesAnOlderAppReads: boolean;
  /** Safe to run again after being cut off at any point. What it did, for the ledger. */
  run(ctx: MigrationContext): Promise<Record<string, unknown>>;
}

/** Where each data root is: the config root (`settings.json`, the plugins) and the app's data
 *  (its token, workspaces and sockets). On Linux they are one folder. */
export function dataRoots(given: Partial<Record<DataRootName, string>> = {}): Record<DataRootName, string> {
  return { config: given.config ?? path.join(configDir(), "hivemind"), data: given.data ?? appData() };
}

/** How long a second process waits for the one migrating; a migration is milliseconds. */
const LOCK_WAIT_MS = 120_000;

export const backupsFolder = (root: string): string => path.join(migrationsFolder(root), "backups");
const lockFile = (root: string): string => path.join(migrationsFolder(root), "lock");

export interface RunOptions {
  by: MigrationRunner;
  /** This build's version. */
  app: string;
  /** Roots elsewhere than `dataRoots()` finds them (the app's own data folder). */
  roots?: Partial<Record<DataRootName, string>>;
  /** A line for the person: waiting, what a migration did, what failed. */
  say?: (line: string) => void;
  /** Whether an app older than this build is running on this machine's data. */
  olderAppRunning?: () => boolean | Promise<boolean>;
}

export interface RootReport {
  root: string;
  applied: AppliedMigration[];
  failed?: { id: string; error: string };
  /** The migration left for later: an older app is running. */
  deferred?: string;
  /** Ids in the ledger this build does not know: a newer build ran them. */
  unknown: string[];
}

export class MigrationsLockedError extends Error {
  constructor(root: string) {
    super(`another hivemind process has been upgrading the data in ${root} for over ${LOCK_WAIT_MS / 1000}s; nothing was run on it. Quit it, or remove ${lockFile(root)} if no hivemind process is running.`);
    this.name = "MigrationsLockedError";
  }
}

/** The migrations of `list` that run on each root folder, by folder; one folder when both roots are one. */
export function migrationsByFolder(roots: Record<DataRootName, string>): Map<string, Migration[]> {
  const out = new Map<string, Migration[]>();
  for (const name of ["config", "data"] as const) {
    const folder = path.resolve(roots[name]);
    if (!out.has(folder)) out.set(folder, []);
    out.get(folder)!.push(...MIGRATIONS.filter((m) => m.root === name));
  }
  for (const ms of out.values()) ms.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/** Run what is pending on every root. A failed migration stops its root there: later ones may
 *  count on it. Throws only when a root's lock or ledger cannot be had. */
export async function runMigrations(o: RunOptions): Promise<RootReport[]> {
  const known = new Set(MIGRATIONS.map((m) => m.id));
  const reports: RootReport[] = [];
  for (const [root, migrations] of migrationsByFolder(dataRoots(o.roots))) {
    const first = await readLedger(root);
    const unknownOf = (l: Ledger) => l.applied.map((a) => a.id).filter((id) => !known.has(id));
    const pending = (l: Ledger) => migrations.filter((m) => !l.applied.some((a) => a.id === m.id));
    const tell = (l: Ledger) => unknownOf(l).length > 0 && !(l.olderBuildsTold ?? []).includes(o.app);
    if (!pending(first).length && !tell(first)) { reports.push({ root, applied: [], unknown: unknownOf(first) }); continue; }
    try {
      reports.push(await holdLock(lockFile(root), async () => {
        let ledger = await readLedger(root);
        const report: RootReport = { root, applied: [], unknown: unknownOf(ledger) };
        if (tell(ledger)) {
          const newest = ledger.applied.filter((a) => !known.has(a.id)).at(-1)!;
          const oldest = ledger.applied.find((a) => !known.has(a.id))!;
          o.say?.(`your data was updated by Hivemind ${newest.app}; this older build may not see all of it. \`hive migrations restore ${oldest.id}\` puts it back.`);
          ledger = { ...ledger, olderBuildsTold: [...(ledger.olderBuildsTold ?? []), o.app] };
          await writeLedger(root, ledger);
        }
        for (const m of pending(ledger)) {
          if (m.movesFilesAnOlderAppReads && o.by !== "app" && await o.olderAppRunning?.()) {
            report.deferred = m.id;
            o.say?.("quit Hivemind to finish updating your data: the app running is an older version, which still reads the files this update moves. Until then this carries on with the data as it is.");
            break;
          }
          const started = Date.now();
          try {
            const backup = await backUp(root, m, !m.changesHere || await m.changesHere({ root }));
            const result = await m.run({ root, remove: (rel) => removeBackedUp(root, m, rel) });
            const entry: AppliedMigration = {
              id: m.id, app: o.app, by: o.by, at: new Date().toISOString(), ms: Date.now() - started,
              ...(backup ? { backup, backedUp: [...m.backsUp] } : {}), result,
            };
            const { failed, ...rest } = ledger;
            ledger = { ...rest, ...(failed && failed.id !== m.id ? { failed } : {}), applied: [...ledger.applied, entry] };
            await writeLedger(root, ledger);
            report.applied.push(entry);
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            ledger = { ...ledger, failed: { id: m.id, app: o.app, at: new Date().toISOString(), error } };
            await writeLedger(root, ledger).catch(() => {});
            report.failed = { id: m.id, error };
            o.say?.(`hivemind could not update your data (${m.id}): ${error}. It carries on with the data as it is; \`hive migrations\` shows this.`);
            break;
          }
        }
        await pruneBackups(root, ledger);
        return report;
      }, LOCK_WAIT_MS, () => o.say?.("another hivemind process is upgrading your data; waiting for it")));
    } catch (e) {
      if (e instanceof SettingsLockError) throw new MigrationsLockedError(root);
      throw e;
    }
  }
  return reports;
}

/** A declared path that may be backed up: inside the root, and never a key or a token. */
function checkedPath(root: string, rel: string): string {
  const parts = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || parts.includes("..") || parts[0] === "identity" || parts.some((p) => p.endsWith(".token") || p.endsWith(".key"))) {
    throw new Error(`a migration may not back up ${rel}`);
  }
  return path.join(root, rel);
}

/** Copy `m`'s paths into its backup, unless it has one: a run after a crash keeps the copy made
 *  before anything changed. The copy is made beside it and renamed into place, so a backup is
 *  whole or not there. Gives its path inside `migrations/`, or none for nothing to back up (or,
 *  `changes` false, nothing it changes here). */
async function backUp(root: string, m: Migration, changes: boolean): Promise<string | undefined> {
  if (!m.backsUp.length) return undefined;
  const folder = backupsFolder(root);
  const dest = path.join(folder, m.id);
  const named = path.relative(migrationsFolder(root), dest).split(path.sep).join("/");
  if (await stat(dest).catch(() => null)) return named;
  if (!changes) return undefined;
  const there = await Promise.all(m.backsUp.map((rel) => stat(checkedPath(root, rel)).then(() => true, () => false)));
  if (!there.includes(true)) return undefined;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const f of await readdir(folder)) if (f.startsWith(`.${m.id}-`)) await rm(path.join(folder, f), { recursive: true, force: true });
  const draft = path.join(folder, `.${m.id}-${randomUUID()}`);
  await mkdir(draft, { mode: 0o700 });
  for (const rel of m.backsUp) {
    const from = checkedPath(root, rel);
    if (!there[m.backsUp.indexOf(rel)]) continue;
    await cp(from, path.join(draft, rel), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
  await rename(draft, dest);
  return named;
}

async function removeBackedUp(root: string, m: Migration, rel: string): Promise<void> {
  if (!m.backsUp.includes(rel)) throw new Error(`${m.id} removes ${rel}, which it does not back up`);
  await rm(checkedPath(root, rel), { recursive: true, force: true });
}

const KEEP_BACKUPS = 3;
const KEEP_BACKUP_MS = 90 * 24 * 60 * 60 * 1000;

/** Keep the backups of the last 3 migrations, and any made in the last 90 days. */
async function pruneBackups(root: string, ledger: Ledger): Promise<void> {
  const withBackup = ledger.applied.filter((a) => a.backup);
  const keep = new Set([
    ...withBackup.slice(-KEEP_BACKUPS).map((a) => a.id),
    ...withBackup.filter((a) => Date.now() - Date.parse(a.at) < KEEP_BACKUP_MS).map((a) => a.id),
  ]);
  for (const a of withBackup) if (!keep.has(a.id)) await rm(path.join(migrationsFolder(root), a.backup!), { recursive: true, force: true });
}

