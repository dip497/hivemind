/**
 * Before a `hive` command touches this machine's data, the data is moved forward to the shape this
 * build reads (`@hivemind/core/migrations`). `hive --version`, `--help` and `hive migrations`
 * itself touch nothing.
 */
import { MigrationsLockedError, runMigrations } from "@hivemind/core/migrations";
import { LedgerUnreadableError } from "@hivemind/core/migrations/ledger";
import { readRunningApp } from "@hivemind/core/migrations/manage";
import { appData } from "@hivemind/core/app-data";
import { appMeetsMinVersion } from "@hivemind/agents";
import { appRunning } from "./host-control.js";

const TOUCHES_NOTHING = new Set(["--version", "-v", "--help", "-h", "migrations"]);

export async function migrateOnStart(argv: readonly string[], app: string): Promise<void> {
  if (!argv.length || TOUCHES_NOTHING.has(argv[0]!) || argv.includes("--help") || argv.includes("-h")) return;
  const by = argv[0] === "host" && argv[1] === "run" ? "host" : "cli";
  const say = (line: string) => process.stderr.write(`hive: ${line}\n`);
  try {
    for (const r of await runMigrations({ by, app, say, olderAppRunning: () => olderAppRunning(app) })) {
      for (const a of r.applied) say(`updated your data: ${a.id}${summary(a.result)}`);
    }
  } catch (e) {
    if (e instanceof MigrationsLockedError || e instanceof LedgerUnreadableError) {
      say(e.message);
      process.exit(1);
    }
    throw e;
  }
}

/** An app runs on this machine's data, and it is not one that said it is this version or newer:
 *  one from before it said so is older. */
async function olderAppRunning(version: string): Promise<boolean> {
  const pid = appRunning(appData());
  if (!pid) return false;
  const said = await readRunningApp(appData());
  return !(said && said.pid === pid && appMeetsMinVersion(said.version, version));
}

/** `adopted 16, could not keep 1 (widgets/agents: no widget.json)` from what a migration did. */
function summary(result: unknown): string {
  const r = (result ?? {}) as { adopted?: unknown; skipped?: unknown };
  const skipped = Array.isArray(r.skipped) ? r.skipped as { path?: string; why?: string }[] : [];
  const parts = [
    ...(typeof r.adopted === "number" ? [`adopted ${r.adopted}`] : []),
    ...(skipped.length ? [`could not keep ${skipped.length} (${skipped.map((s) => `${s.path}: ${s.why}`).join("; ")})`] : []),
  ];
  return parts.length ? `, ${parts.join(", ")}` : "";
}
