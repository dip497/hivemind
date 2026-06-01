/**
 * `hive move <ID> <PREFIX>` — transfer an issue into another workspace.
 *
 *   hive move PAY-42 OPS          move PAY-42 into the OPS workspace (deletes source)
 *   hive move PAY-42 OPS --copy   copy instead of move (source kept, mutual relates link)
 *
 * The destination workspace is named by its prefix and resolved via the
 * registry (`hive workspace list`). Move refuses an issue with sub-issues.
 */
import { defineCommand } from "citty";
import { HiveError, requireRoot, transferIssue } from "@hivemind/core";
import { err, ok } from "../format.js";
import { detectWho } from "../who.js";
import { stripAt } from "../parse.js";

export const moveCmd = defineCommand({
  meta: {
    name: "move",
    description: "Move (or --copy) an issue into another workspace by prefix",
  },
  args: {
    id: { type: "positional", required: true, description: "Issue id (PAY-42 or @PAY-42)" },
    prefix: { type: "positional", required: true, description: "Destination workspace prefix (e.g. OPS)" },
    copy: { type: "boolean", description: "Copy instead of move (keep the source)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      const prefix = String(args.prefix).toUpperCase();
      const mode = args.copy ? "copy" : "move";
      const res = await transferIssue(root, id, prefix, { mode, actor: detectWho() });
      return ok(ctx, res, () => `${mode === "copy" ? "copied" : "moved"} ${id} → ${res.newId}`);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "move_failed";
      return err(ctx, code, msg);
    }
  },
});
