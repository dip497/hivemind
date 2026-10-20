/**
 * `hive migrations`: which migrations ran on this machine's data, by which build and when, what is
 * still to run, the last failure and the backups. `hive migrations restore <id>` puts back the data
 * as it was before `<id>`, and before every migration after it.
 */
import { defineCommand } from "citty";
import { appData } from "@hivemind/core/app-data";
import { migrationsStatus, restoreMigration, RestoreRefusedError, type RootStatus } from "@hivemind/core/migrations/manage";
import { LedgerUnreadableError } from "@hivemind/core/migrations/ledger";
import { appRunning, askHost, controlSocket } from "../host-control.js";
import { EXIT } from "../exit-codes.js";
import { err, ok } from "../format.js";

function render(roots: RootStatus[]): string {
  const lines: string[] = [];
  for (const r of roots) {
    lines.push(r.root);
    if (!r.applied.length && !r.pending.length && !r.failed) lines.push("  nothing to do");
    for (const a of r.applied) {
      const backup = a.backup ? (a.backupKept ? `backup in migrations/${a.backup}` : "backup gone") : "no backup";
      lines.push(`  ran      ${a.id}  ${a.at.slice(0, 16).replace("T", " ")}  by the ${a.by} ${a.app}, ${a.ms} ms; ${backup}${a.known ? "" : " (a newer build's)"}`);
      const skipped = (a.result as { skipped?: { path: string; why: string }[] } | undefined)?.skipped ?? [];
      for (const x of skipped) lines.push(`           not kept: ${x.path}: ${x.why}`);
    }
    for (const id of r.pending) lines.push(`  to run   ${id}`);
    if (r.failed) lines.push(`  failed   ${r.failed.id}  ${r.failed.at.slice(0, 16).replace("T", " ")}  ${r.failed.error}`);
  }
  return lines.join("\n");
}

/** A process that would read the data while it is put back: the app, or `hive host`. */
async function holder(): Promise<string | null> {
  const dir = appData();
  const app = appRunning(dir);
  if (app) return `the app runs (pid ${app})`;
  try { await askHost(controlSocket(dir), "status", {}, 1_000); return "hive host runs"; } catch { return null; }
}

const restoreCmd = defineCommand({
  meta: { name: "restore", description: "Put back the data as it was before a migration (and every one after it); the next start runs them again" },
  args: { id: { type: "positional", required: true, description: "The migration's id, as `hive migrations` lists it" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const busy = await holder();
    if (busy) return err(ctx, "data_in_use", `${busy}: quit it, then run \`hive migrations restore ${String(args.id)}\` again. Nothing was changed.`, EXIT.refused);
    try {
      const r = await restoreMigration(String(args.id));
      return ok(ctx, r, () => `put back the data of ${r.root} as it was before ${r.restored.slice().reverse().join(", ")}; the next start runs ${r.restored.length > 1 ? "them" : "it"} again`);
    } catch (e) {
      if (e instanceof RestoreRefusedError) return err(ctx, "restore_refused", e.message, EXIT.refused);
      if (e instanceof LedgerUnreadableError) return err(ctx, "ledger_unreadable", e.message);
      throw e;
    }
  },
});

export const migrationsCmd = defineCommand({
  meta: { name: "migrations", description: "The changes made to this machine's data when Hivemind updated, and undoing one" },
  args: { json: { type: "boolean" } },
  subCommands: { restore: restoreCmd },
  async run({ args, rawArgs }) {
    if (rawArgs[0] === "restore") return;
    const ctx = { json: !!args.json };
    try {
      const roots = await migrationsStatus();
      return ok(ctx, { roots }, () => render(roots));
    } catch (e) {
      if (e instanceof LedgerUnreadableError) return err(ctx, "ledger_unreadable", e.message);
      throw e;
    }
  },
});
