import { defineCommand } from "citty";
import {
  HiveError,
  appendActivity,
  readIssue,
  requireRoot,
  writeAgentContext,
  writeIssue,
} from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { detectWho } from "../who.js";
import { parseAssignee, parseState, stripAt } from "../parse.js";

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
      const issue = await readIssue(root, id);

      const changes: string[] = [];

      if (args.state !== undefined) {
        const ns = parseState(String(args.state));
        if (!ns) return err(ctx, "bad_state", `invalid state: ${args.state}`);
        if (ns !== issue.state) {
          changes.push(`state ${issue.state} → ${ns}`);
          issue.state = ns;
        }
      }
      if (args.title !== undefined) {
        const t = String(args.title);
        if (t !== issue.title) {
          changes.push(`title → "${t}"`);
          issue.title = t;
        }
      }
      if (args.assignee !== undefined) {
        const next =
          args.assignee === "none" || args.assignee === ""
            ? null
            : parseAssignee(
                String(args.assignee),
                args["assignee-type"] as "agent" | "member" | undefined,
                args["assignee-model"] as string | undefined
              );
        const before = issue.assignee?.id ?? "—";
        const after = next?.id ?? "—";
        if (before !== after) {
          changes.push(`assignee ${before} → ${after}`);
          issue.assignee = next;
        }
      }
      const adds = collectMulti(args["add-label"]);
      const removes = collectMulti(args["rm-label"]);
      if (adds.length || removes.length) {
        const set = new Set(issue.labels);
        for (const l of adds) set.add(l);
        for (const l of removes) set.delete(l);
        const next = Array.from(set);
        if (JSON.stringify(next) !== JSON.stringify(issue.labels)) {
          changes.push(`labels → [${next.join(",")}]`);
          issue.labels = next;
        }
      }
      if (args.github !== undefined) {
        const next =
          args.github === "none" || args.github === "" ? null : Number(args.github);
        if (args.github !== "none" && (!Number.isInteger(next) || (next as number) <= 0)) {
          return err(ctx, "bad_github", `--github must be a positive integer or 'none'`);
        }
        if (next !== issue.github) {
          changes.push(`github ${issue.github ?? "—"} → ${next ?? "—"}`);
          issue.github = next;
        }
      }

      const note = args.note ? String(args.note).trim() : "";
      if (changes.length === 0 && !note) {
        return err(ctx, "noop", `no fields changed and no --note provided`);
      }
      const who = detectWho();
      const messages = [...changes];
      if (note) messages.push(note);
      for (const m of messages) appendActivity(issue, who, m);

      await writeIssue(issue);
      await writeAgentContext(root);
      return ok(ctx, issue, () => renderIssue(issue));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "update_failed";
      return err(ctx, code, msg);
    }
  },
});

function collectMulti(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}
