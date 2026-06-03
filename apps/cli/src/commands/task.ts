/**
 * "Task" is sugar over the sub-issue mechanism — every task is a sub-issue.
 * `hive task <PARENT> add "title"`   → creates PARENT.N (defaults to state=todo)
 * `hive task <PARENT> done <SUBID>`  → sets state=done on PARENT.SUBID
 * `hive task <PARENT> list`          → lists children of PARENT
 *
 * The SUBID arg accepts either the full id (PAY-122.3) or just the tail (.3 or 3).
 */
import { defineCommand } from "citty";
import {
  HiveError,
  childrenOf,
  createIssue,
  listIssues,
  readIssue,
  requireRoot,
  updateIssue,
  writeAgentContext,
} from "@hivemind/core";
import { err, ok, renderIssue, renderIssueList } from "../format.js";
import { detectWho } from "../who.js";
import { stripAt } from "../parse.js";

function normaliseSubId(parent: string, ref: string): string {
  const r = stripAt(ref);
  if (r.startsWith(parent + ".")) return r;
  if (r.startsWith(".")) return parent + r;
  if (/^\d+$/.test(r)) return `${parent}.${r}`;
  return r;
}

const addSub = defineCommand({
  meta: {
    name: "add",
    description: "Add a subtask: hive task add <PARENT> \"<title>\"",
  },
  args: {
    parent: { type: "positional", required: true, description: "Parent issue ID" },
    title: { type: "positional", required: true, description: "Subtask title" },
    state: { type: "string", description: "Initial state (default todo)" },
    assignee: { type: "string" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const parent = stripAt(String(args.parent));
      try {
        await readIssue(root, parent);
      } catch {
        return err(ctx, "bad_parent", `parent ${parent} does not exist`);
      }
      // Core owns sub-issue id allocation + the default body + activity format.
      const issue = await createIssue(root, {
        title: String(args.title),
        parent,
        state: (args.state ? String(args.state) : "todo") as Parameters<typeof createIssue>[1]["state"],
        assignee: args.assignee ? { type: "agent", id: String(args.assignee).toLowerCase() } : null,
        who: detectWho(),
      });
      await writeAgentContext(root);
      return ok(ctx, { id: issue.id, parent, path: issue.path }, () => renderIssue(issue));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "task_add_failed";
      return err(ctx, code, msg);
    }
  },
});

const doneSub = defineCommand({
  meta: {
    name: "done",
    description: "Mark a subtask done: hive task done <PARENT> <SUBID>",
  },
  args: {
    parent: { type: "positional", required: true, description: "Parent issue ID" },
    sub: { type: "positional", required: true, description: "Sub-issue id or tail (.3 / 3)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const parent = stripAt(String(args.parent));
      const id = normaliseSubId(parent, String(args.sub));
      const issue = await readIssue(root, id);
      if (issue.state === "done") return err(ctx, "noop", `${id} already done`);
      const updated = await updateIssue(root, id, { state: "done" }, detectWho());
      await writeAgentContext(root);
      return ok(ctx, updated, () => renderIssue(updated));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "task_done_failed";
      return err(ctx, code, msg);
    }
  },
});

const listSub = defineCommand({
  meta: {
    name: "list",
    description: "List subtasks of a parent: hive task list <PARENT>",
  },
  args: {
    parent: { type: "positional", required: true, description: "Parent issue ID" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const parent = stripAt(String(args.parent));
      const all = await listIssues(root);
      const children = childrenOf(all, parent);
      return ok(ctx, children, () => renderIssueList(children));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "task_list_failed";
      return err(ctx, code, msg);
    }
  },
});

export const taskCmd = defineCommand({
  meta: { name: "task", description: "Subtask shortcuts (sub-issue sugar)" },
  subCommands: { add: addSub, done: doneSub, list: listSub },
});
