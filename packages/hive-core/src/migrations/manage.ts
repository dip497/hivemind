/**
 * What `hive migrations` shows and does: each data root's ledger with what is still to run, and
 * `restore`, which puts a migration's backup back, with every one after it, so the next start runs
 * them again. Also the record of which app version is running, which a `hive` command reads
 * before it moves files an older app still reads.
 */
import { cp, readFile, rm, stat, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { holdLock, SettingsLockError } from "../settings.js";
import { migrationsFolder, readLedger, writeLedger, type AppliedMigration, type FailedMigration } from "./ledger.js";
import { dataRoots, migrationsByFolder, type DataRootName } from "./runner.js";
import { MIGRATIONS } from "./list.js";

export interface RootStatus {
  root: string;
  applied: Array<AppliedMigration & { backupKept: boolean; known: boolean }>;
  pending: string[];
  failed?: FailedMigration;
}

/** Every root's ledger, and what this build would still run on it. */
export async function migrationsStatus(roots: Partial<Record<DataRootName, string>> = {}): Promise<RootStatus[]> {
  const known = new Set(MIGRATIONS.map((m) => m.id));
  const out: RootStatus[] = [];
  for (const [root, migrations] of migrationsByFolder(dataRoots(roots))) {
    const ledger = await readLedger(root);
    const applied = await Promise.all(ledger.applied.map(async (a) => ({
      ...a, known: known.has(a.id),
      backupKept: !!a.backup && !!(await stat(path.join(migrationsFolder(root), a.backup)).catch(() => null)),
    })));
    out.push({ root, applied, pending: migrations.filter((m) => !ledger.applied.some((a) => a.id === m.id)).map((m) => m.id), ...(ledger.failed ? { failed: ledger.failed } : {}) });
  }
  return out;
}

export class RestoreRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "RestoreRefusedError"; }
}

/**
 * Put back what migration `id` changed, and what every migration after it on that root changed,
 * newest first, from their backups; then take them out of the ledger, so the next start runs them
 * again. Refused, with nothing changed, when another hivemind process holds the root or a backup
 * it needs is gone. Gives the ids taken out.
 */
export async function restoreMigration(id: string, roots: Partial<Record<DataRootName, string>> = {}): Promise<{ root: string; restored: string[] }> {
  for (const root of migrationsByFolder(dataRoots(roots)).keys()) {
    const first = await readLedger(root);
    if (!first.applied.some((a) => a.id === id)) continue;
    try {
      return await holdLock(path.join(migrationsFolder(root), "lock"), async () => {
        const ledger = await readLedger(root);
        const at = ledger.applied.findIndex((a) => a.id === id);
        if (at < 0) throw new RestoreRefusedError(`${id} was taken out of the ledger meanwhile; nothing was changed`);
        const undo = ledger.applied.slice(at).reverse();
        for (const a of undo) {
          if (a.backup && !(await stat(path.join(migrationsFolder(root), a.backup)).catch(() => null))) {
            throw new RestoreRefusedError(`the backup of ${a.id} is gone (only the last 3, and those of the last 90 days, are kept); nothing was changed`);
          }
        }
        for (const a of undo) {
          if (!a.backup) continue;
          const backup = path.join(migrationsFolder(root), a.backup);
          for (const rel of a.backedUp ?? []) {
            const kept = path.join(backup, rel);
            await rm(path.join(root, rel), { recursive: true, force: true });
            if (await stat(kept).catch(() => null)) await cp(kept, path.join(root, rel), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
          }
        }
        const gone = new Set(undo.map((a) => a.id));
        const { failed, ...rest } = ledger;
        await writeLedger(root, { ...rest, applied: ledger.applied.slice(0, at), ...(failed && !gone.has(failed.id) ? { failed } : {}) });
        for (const a of undo) if (a.backup) await rm(path.join(migrationsFolder(root), a.backup), { recursive: true, force: true });
        return { root, restored: undo.map((a) => a.id) };
      }, 2_000);
    } catch (e) {
      if (e instanceof SettingsLockError) throw new RestoreRefusedError(`another hivemind process is using ${root}; quit it and try again. Nothing was changed.`);
      throw e;
    }
  }
  throw new RestoreRefusedError(`no migration ${id} has run on this machine: \`hive migrations\` lists those that have`);
}

const runningAppFile = (dataRoot: string): string => path.join(migrationsFolder(dataRoot), "running-app.json");

/** The app says which version it is, once its migrations ran. */
export async function recordRunningApp(dataRoot: string, version: string): Promise<void> {
  const file = runningAppFile(dataRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const draft = `${file}.${process.pid}`;
  await writeFile(draft, JSON.stringify({ pid: process.pid, version }) + "\n");
  await rename(draft, file);
}

/** Which app version said it runs on `dataRoot`, and as which process; null when none did. */
export async function readRunningApp(dataRoot: string): Promise<{ pid: number; version: string } | null> {
  try {
    const r = JSON.parse(await readFile(runningAppFile(dataRoot), "utf8")) as { pid?: unknown; version?: unknown };
    return typeof r.pid === "number" && typeof r.version === "string" ? { pid: r.pid, version: r.version } : null;
  } catch { return null; }
}
