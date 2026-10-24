import { defineCommand } from "citty";
import { HiveError, SyncLockedError, ingestRecords, requireRoot, writeAgentContext, type IngestReport } from "@hivemind/core";
import { err, ok } from "../format.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const render = (r: IngestReport): string =>
  [
    `${r.dryRun ? "would ingest" : "ingested"} ${r.source}: ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.archived.length} archived, ${r.conflicts.length} conflicts`,
    ...r.conflicts.map((c) => `  conflict ${c.id}: hive has ${c.local}, the tracker moved to ${c.remote}`),
    ...r.notes.map((n) => `  note: ${n}`),
  ].join("\n");

export const ingestCmd = defineCommand({
  meta: {
    name: "ingest",
    description: "Mirror issues from an external tracker: one normalised record per stdin line (NDJSON), upserted by the source's issue id",
  },
  args: {
    source: { type: "string", required: true, description: "The source the records come from, e.g. jira:acme/PAY" },
    "dry-run": { type: "boolean", description: "Report what would change and write nothing" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const records: unknown[] = [];
      for (const [i, line] of (await readStdin()).split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          return err(ctx, "bad_request", `stdin line ${i + 1} is not JSON`, undefined, "one JSON record per line (NDJSON)");
        }
      }
      const report = await ingestRecords(root, String(args.source), records, { dryRun: !!args["dry-run"] });
      if (!report.dryRun && report.created.length + report.updated.length + report.archived.length > 0) await writeAgentContext(root);
      return ok(ctx, report, () => render(report));
    } catch (e) {
      if (e instanceof SyncLockedError) return err(ctx, "sync_locked", e.message, undefined, "wait for that sync to finish; a lock whose process is gone is taken over");
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "ingest_failed";
      return err(ctx, code, msg);
    }
  },
});
