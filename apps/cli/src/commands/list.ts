import { defineCommand } from "citty";
import { HiveError, filterIssues, listIssues, requireRoot } from "@hivemind/core";
import { err, ok, renderIssueList } from "../format.js";
import { parseState, stripAt } from "../parse.js";

export const listCmd = defineCommand({
  meta: { name: "list", description: "List issues (filterable)" },
  args: {
    state: { type: "string", description: "Filter by state (repeatable)" },
    assignee: { type: "string", description: "Filter by assignee id" },
    label: { type: "string", description: "Filter by label" },
    parent: { type: "string", description: "Filter by parent (use 'none' for top-level)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const all = await listIssues(root);

      const filter: {
        state?: ReturnType<typeof parseState>[];
        assignee?: string;
        label?: string;
        parent?: string | null;
      } = {};
      if (args.state) {
        const states = Array.isArray(args.state) ? args.state : [args.state];
        const parsed = states.map((s: string) => parseState(String(s)));
        if (parsed.some((p) => p === null)) {
          return err(ctx, "bad_state", `invalid state in: ${states.join(", ")}`);
        }
        filter.state = parsed;
      }
      if (args.assignee) filter.assignee = String(args.assignee).toLowerCase();
      if (args.label) filter.label = String(args.label);
      if (args.parent !== undefined && args.parent !== "") {
        const p = String(args.parent);
        filter.parent = p === "none" || p === "null" ? null : stripAt(p);
      }

      const matched = filterIssues(
        all,
        filter as Parameters<typeof filterIssues>[1]
      );
      return ok(ctx, matched, () => renderIssueList(matched));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "list_failed";
      return err(ctx, code, msg);
    }
  },
});
