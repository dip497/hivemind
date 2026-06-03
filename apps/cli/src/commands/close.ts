import { defineCommand } from "citty";
import {
  HiveError,
  readIssue,
  requireRoot,
  updateIssue,
  writeAgentContext,
} from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { detectWho } from "../who.js";
import { stripAt } from "../parse.js";

/** Join non-empty note fragments into one activity note. */
const joinNotes = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" — ") || undefined;

export const closeCmd = defineCommand({
  meta: { name: "close", description: "Mark an issue done (or cancelled with --reason)" },
  args: {
    id: { type: "positional", required: true, description: "Issue ID" },
    reason: { type: "string", description: "If given, sets state=cancelled" },
    note: { type: "string", description: "Free-text note appended to Activity" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      const issue = await readIssue(root, id);
      const next = args.reason ? "cancelled" : "done";
      if (issue.state === next) {
        return err(ctx, "noop", `issue ${id} already ${next}`);
      }
      const note = joinNotes(args.reason ? String(args.reason) : undefined, args.note ? String(args.note) : undefined);
      const updated = await updateIssue(root, id, { state: next }, detectWho(), note);
      await writeAgentContext(root);
      return ok(ctx, updated, () => renderIssue(updated));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "close_failed";
      return err(ctx, code, msg);
    }
  },
});

export const reopenCmd = defineCommand({
  meta: { name: "reopen", description: "Reopen a done/cancelled issue (→ todo)" },
  args: {
    id: { type: "positional", required: true, description: "Issue ID" },
    state: { type: "string", description: "Target state (default todo)" },
    note: { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      const issue = await readIssue(root, id);
      const target = args.state ? String(args.state) : "todo";
      if (!["backlog", "todo", "in_progress", "in_review"].includes(target)) {
        return err(ctx, "bad_state", `reopen target must be active state (got ${target})`);
      }
      if (issue.state === target) {
        return err(ctx, "noop", `issue ${id} already ${target}`);
      }
      const note = joinNotes("reopened", args.note ? String(args.note) : undefined);
      const updated = await updateIssue(
        root,
        id,
        { state: target as typeof issue.state },
        detectWho(),
        note,
      );
      await writeAgentContext(root);
      return ok(ctx, updated, () => renderIssue(updated));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "reopen_failed";
      return err(ctx, code, msg);
    }
  },
});
