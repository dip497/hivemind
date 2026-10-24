import { defineCommand } from "citty";
import { HiveError, filterIssues, listIssues, loadWorkflow, requireRoot, resolveStatus, rootForIdHere, statusChoices, statusOf, workflowView } from "@hivemind/core";
import { err, ok, renderIssueList } from "../format.js";
import { parseState, stripAt } from "../parse.js";

export const listCmd = defineCommand({
  meta: { name: "list", description: "List issues (filterable)" },
  args: {
    state: { type: "string", description: "Filter by state (repeatable)" },
    category: { type: "string", description: "Filter by category, the state a status is in (repeatable)" },
    status: { type: "string", description: "Filter by workflow status, id or name (repeatable)" },
    assignee: { type: "string", description: "Filter by assignee id" },
    label: { type: "string", description: "Filter by label" },
    parent: { type: "string", description: "Filter by parent (use 'none' for top-level)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      // `--parent <id>` lists that issue's children wherever it lives (design jira-sync §5.2).
      const parentId = args.parent ? stripAt(String(args.parent)) : "";
      const byId = parentId && parentId !== "none" && parentId !== "null";
      const root = byId ? await rootForIdHere(parentId) : await requireRoot();
      const all = await listIssues(root);

      const filter: {
        state?: ReturnType<typeof parseState>[];
        category?: ReturnType<typeof parseState>[];
        status?: string[];
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
      if (args.category) {
        const cats = (Array.isArray(args.category) ? args.category : [args.category]).map(String);
        const parsed = cats.map((s) => parseState(s));
        if (parsed.some((p) => p === null)) return err(ctx, "bad_state", `invalid category in: ${cats.join(", ")}`);
        filter.category = parsed;
      }
      const wf = loadWorkflow(root);
      if (args.status) {
        const names = (Array.isArray(args.status) ? args.status : [args.status]).map(String);
        const ids: string[] = [];
        for (const n of names) {
          const s = resolveStatus(wf, n);
          if (!s) return err(ctx, "bad_status", `unknown status "${n}"; this workspace has: ${statusChoices(wf)}`, undefined, "hive statuses show");
          ids.push(s.id);
        }
        filter.status = ids;
      }
      if (args.assignee) filter.assignee = String(args.assignee).toLowerCase();
      if (args.label) filter.label = String(args.label);
      if (args.parent !== undefined && args.parent !== "") {
        const p = String(args.parent);
        filter.parent = p === "none" || p === "null" ? null : stripAt(p);
      }

      const filtered = filterIssues(all, filter as Parameters<typeof filterIssues>[1], wf);
      // With a workflow of its own each issue names its status; without one the list is as it was.
      const view = workflowView(wf);
      const matched = view.custom
        ? filtered.map((i) => {
            const status = statusOf(wf, i);
            return { ...i, status, statusName: view.statuses.find((s) => s.id === status)?.name ?? status };
          })
        : filtered;
      return ok(ctx, { issues: matched }, () => renderIssueList(matched));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "list_failed";
      return err(ctx, code, msg);
    }
  },
});
