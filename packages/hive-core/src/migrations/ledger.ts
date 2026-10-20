/**
 * The ledger of one data root: `<root>/migrations/ledger.json`, the migrations that ran on it, by
 * which build and when, and the last one that failed. An id this build does not know (a newer
 * build ran it) is kept on every write.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type MigrationRunner = "app" | "cli" | "host";

export interface AppliedMigration {
  id: string;
  /** The version of the build that ran it. */
  app: string;
  by: MigrationRunner;
  at: string;
  ms: number;
  /** Where its backup is, inside `<root>/migrations/`; none when it backed nothing up. */
  backup?: string;
  result?: unknown;
}

export interface FailedMigration { id: string; app: string; at: string; error: string }

export interface Ledger {
  applied: AppliedMigration[];
  failed?: FailedMigration;
  /** The older builds already told that a newer one changed this data. */
  olderBuildsTold?: string[];
}

export const LEDGER_FORMAT = "hivemind-migrations";

export const migrationsFolder = (root: string): string => path.join(root, "migrations");
export const ledgerFile = (root: string): string => path.join(migrationsFolder(root), "ledger.json");

export class LedgerUnreadableError extends Error {
  constructor(file: string, why: string) {
    super(`${file} cannot be read (${why}); no migration was run. Move it aside to start the ledger again.`);
    this.name = "LedgerUnreadableError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The ledger of `root`; empty when there is none yet. */
export async function readLedger(root: string): Promise<Ledger> {
  const file = ledgerFile(root);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { applied: [] };
    throw new LedgerUnreadableError(file, (e as Error).message);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new LedgerUnreadableError(file, "it is not JSON"); }
  if (!isObj(raw) || raw.format !== LEDGER_FORMAT || !Array.isArray(raw.applied)) throw new LedgerUnreadableError(file, `it is not a ${LEDGER_FORMAT} ledger`);
  const applied = raw.applied.filter((a): a is AppliedMigration => isObj(a) && typeof a.id === "string");
  const failed = isObj(raw.failed) && typeof raw.failed.id === "string" ? raw.failed as unknown as FailedMigration : undefined;
  const told = Array.isArray(raw.olderBuildsTold) ? raw.olderBuildsTold.filter((v): v is string => typeof v === "string") : [];
  return { applied, ...(failed ? { failed } : {}), ...(told.length ? { olderBuildsTold: told } : {}) };
}

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Write the ledger whole: a draft beside it, then one rename. On Windows a scanner or indexer
 *  holding the file for a moment refuses the rename, so it is tried again for up to 2 s. */
export async function writeLedger(root: string, ledger: Ledger): Promise<void> {
  const file = ledgerFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  const draft = `${file}.${randomUUID()}`;
  try {
    await writeFile(draft, JSON.stringify({ format: LEDGER_FORMAT, v: 1, ...ledger }, null, 2) + "\n");
    const until = Date.now() + 2_000;
    for (;;) {
      try { await rename(draft, file); return; } catch (e) {
        if (!RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? "") || Date.now() >= until) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } finally { await rm(draft, { force: true }).catch(() => {}); }
}
