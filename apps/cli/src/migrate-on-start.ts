/**
 * Before a `hive` command touches this machine's data, the data is moved forward to the shape this
 * build reads (`@hivemind/core/migrations`). `hive --version`, `--help` and `hive migrations`
 * itself touch nothing.
 */
import { MigrationsLockedError, runMigrations } from "@hivemind/core/migrations";
import { LedgerUnreadableError } from "@hivemind/core/migrations/ledger";

const TOUCHES_NOTHING = new Set(["--version", "-v", "--help", "-h", "migrations"]);

export async function migrateOnStart(argv: readonly string[], app: string): Promise<void> {
  if (!argv.length || TOUCHES_NOTHING.has(argv[0]!) || argv.includes("--help") || argv.includes("-h")) return;
  const by = argv[0] === "host" && argv[1] === "run" ? "host" : "cli";
  const say = (line: string) => process.stderr.write(`hive: ${line}\n`);
  try {
    for (const r of await runMigrations({ by, app, say })) {
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
