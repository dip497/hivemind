import { defineCommand } from "citty";
import {
  HiveError,
  readIssue,
  requireRoot,
  updateIssue,
  writeAgentContext,
  type IssuePatch,
} from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { detectWho } from "../who.js";
import { collectMulti, parseAssignee, parseState, stripAt } from "../parse.js";

export const updateCmd = defineCommand({
  meta: { name: "update", description: "Update fields of an existing issue" },
  args: {
    id: { type: "positional", required: true, description: "Issue ID" },
    state: { type: "string", description: "New state" },
    title: { type: "string", description: "New title" },
    assignee: { type: "string", description: "Assignee id (or 'none' to unset)" },
    "assignee-type": { type: "string" },
    "assignee-model": { type: "string" },
    "add-label": { type: "string", description: "Add a label (repeatable)" },
    "rm-label": { type: "string", description: "Remove a label (repeatable)" },
    github: { type: "string", description: "Linked GitHub issue/PR number (or 'none')" },
    note: { type: "string", description: "Free-text note appended to Activity" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      // The CLI validates/parses flags into a patch; core owns the diff,
      // canonical activity format, and write. We read once only to resolve the
      // add/remove-label SET semantics into a final labels array.
      const issue = await readIssue(root, id);
      const patch: IssuePatch = {};

      if (args.state !== undefined) {
        const ns = parseState(String(args.state));
        if (!ns) return err(ctx, "bad_state", `invalid state: ${args.state}`);
        patch.state = ns;
      }
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.assignee !== undefined) {
        patch.assignee =
          args.assignee === "none" || args.assignee === ""
            ? null
            : parseAssignee(
                String(args.assignee),
                args["assignee-type"] as "agent" | "member" | undefined,
                args["assignee-model"] as string | undefined
              );
      }
      const adds = collectMulti(args["add-label"]);
      const removes = collectMulti(args["rm-label"]);
      if (adds.length || removes.length) {
        const set = new Set(issue.labels);
        for (const l of adds) set.add(l);
        for (const l of removes) set.delete(l);
        patch.labels = Array.from(set);
      }
      if (args.github !== undefined) {
        const unset = args.github === "none" || args.github === "";
        const next = unset ? null : Number(args.github);
        if (!unset && (!Number.isInteger(next) || (next as number) <= 0)) {
          return err(ctx, "bad_github", `--github must be a positive integer or 'none'`);
        }
        patch.github = next;
      }

      const note = args.note ? String(args.note).trim() : "";
      if (Object.keys(patch).length === 0 && !note) {
        return err(ctx, "noop", `no fields changed and no --note provided`);
      }

      const updated = await updateIssue(root, id, patch, detectWho(), note || undefined);
      await writeAgentContext(root);
      return ok(ctx, updated, () => renderIssue(updated));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "update_failed";
      return err(ctx, code, msg);
    }
  },
});
