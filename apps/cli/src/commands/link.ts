/**
 * Re-parent an issue. Validates: parent exists, no cycles.
 *
 * Note: this only changes the `parent` frontmatter field. It does NOT
 * move files on disk (would invalidate IDs). The on-disk layout is a
 * naming convention; the source of truth is the `parent` field.
 */
import { defineCommand } from "citty";
import {
  HiveError,
  appendActivity,
  isDescendantOf,
  listIssues,
  readIssue,
  requireRoot,
  writeAgentContext,
  writeIssue,
} from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { detectWho } from "../who.js";
import { stripAt } from "../parse.js";

export const linkCmd = defineCommand({
  meta: { name: "link", description: "Re-parent an issue (or unparent with --parent none)" },
  args: {
    id: { type: "positional", required: true, description: "Issue ID" },
    parent: { type: "string", required: true, description: "New parent id (or 'none')" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      const newParent =
        args.parent === "none" || args.parent === "" ? null : stripAt(String(args.parent));
      const issue = await readIssue(root, id);
      if (newParent) {
        try {
          await readIssue(root, newParent);
        } catch {
          return err(ctx, "bad_parent", `parent ${newParent} does not exist`);
        }
        if (newParent === id) {
          return err(ctx, "cycle", `cannot make ${id} a child of itself`);
        }
        // No cycles: newParent must not be a descendant of id.
        const all = await listIssues(root);
        if (isDescendantOf(all, newParent, id)) {
          return err(
            ctx,
            "cycle",
            `cannot link: ${newParent} is a descendant of ${id}`
          );
        }
      }
      if (issue.parent === newParent) {
        return err(ctx, "noop", `issue ${id} already has parent ${newParent ?? "—"}`);
      }
      appendActivity(
        issue,
        detectWho(),
        `parent ${issue.parent ?? "—"} → ${newParent ?? "—"}`
      );
      issue.parent = newParent;
      await writeIssue(issue);
      await writeAgentContext(root);
      return ok(ctx, issue, () => renderIssue(issue));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "link_failed";
      return err(ctx, code, msg);
    }
  },
});
