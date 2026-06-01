/**
 * `hive relate <ID> <OTHER-ID>` — cross-repo (or intra-repo non-parent) link.
 *
 *   hive relate PAY-42 OPS-7                 PAY-42 relates-to OPS-7
 *   hive relate PAY-42 OPS-7 --type blocks   PAY-42 blocks OPS-7 (OPS-7 gets blocked-by)
 *   hive relate PAY-42 OPS-7 --remove        drop the link from both ends
 *
 * The reciprocal is recorded on the other issue automatically. `OTHER-ID`'s
 * workspace is resolved from its prefix via the registry. For the single-repo
 * parent/child hierarchy use `hive link` instead.
 */
import { defineCommand } from "citty";
import {
  HiveError,
  LinkTypeZ,
  linkIssues,
  requireRoot,
  unlinkIssues,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { detectWho } from "../who.js";
import { stripAt } from "../parse.js";

export const relateCmd = defineCommand({
  meta: {
    name: "relate",
    description: "Link two issues across repos (relates/blocks/duplicates/…)",
  },
  args: {
    id: { type: "positional", required: true, description: "Source issue id" },
    other: { type: "positional", required: true, description: "Target issue id (any workspace)" },
    type: {
      type: "string",
      description: "relates|blocks|blocked-by|duplicates|parent-of|child-of (default relates)",
    },
    remove: { type: "boolean", description: "Remove the link from both ends" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      const other = stripAt(String(args.other));
      if (args.remove) {
        const removed = await unlinkIssues(root, id, other, detectWho());
        return ok(ctx, { removed }, () => `unlinked ${id} ↔ ${other} (${removed} ends)`);
      }
      const parsed = LinkTypeZ.safeParse(args.type ?? "relates");
      if (!parsed.success) {
        return err(ctx, "bad_type", `invalid link type '${args.type}' (use relates/blocks/blocked-by/duplicates/parent-of/child-of/moved-to/moved-from)`);
      }
      const res = await linkIssues(root, id, other, parsed.data, detectWho());
      return ok(ctx, res, () => `${id} ${res.type} ${other}  (${other} ${res.reciprocal} ${id})`);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "relate_failed";
      return err(ctx, code, msg);
    }
  },
});
