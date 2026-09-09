import { defineCommand } from "citty";
import { CATALOG } from "@hivemind/agents";
import { inspectPackage } from "@hivemind/core/packages";
import { HiveError } from "@hivemind/core";
import { err, ok } from "../format.js";

const escapeControl = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

export const packagesCmd = defineCommand({
  meta: { name: "packages", description: "Inspect workspace bundles (development preview)" },
  subCommands: {
    inspect: defineCommand({
      meta: { name: "inspect", description: "Validate a local bundle and show its startup plan without executing it" },
      args: { dir: { type: "positional", required: true }, json: { type: "boolean" } },
      async run({ args }) {
        const ctx = { json: !!args.json };
        try {
          const report = await inspectPackage(String(args.dir), CATALOG.map((p) => ({
            id: p.id, enabled: p.enabled, modelFlag: p.caps.modelFlag, supervision: p.caps.supervise,
          })));
          // Keep even human output escaped: package-authored text must not emit terminal controls.
          return ok(ctx, report, () => JSON.stringify(report, null, 2).replace(/[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, escapeControl));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return err(ctx, e instanceof HiveError ? e.code : "inspect_failed", message.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, escapeControl));
        }
      },
    }),
  },
});
