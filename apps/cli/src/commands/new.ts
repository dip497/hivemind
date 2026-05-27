import { defineCommand } from "citty";
import {
  HiveError,
  allocateId,
  appendActivity,
  issuePath,
  readIssue,
  requireRoot,
  writeAgentContext,
  writeIssue,
  type Issue,
} from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { detectWho } from "../who.js";
import { parseAssignee, parseState, stripAt } from "../parse.js";

export const newCmd = defineCommand({
  meta: {
    name: "new",
    description: "Create a new issue. Title is required.",
  },
  args: {
    title: { type: "positional", description: "Issue title", required: true },
    label: { type: "string", description: "Label (repeatable)" },
    cycle: { type: "string", description: "Cycle id (e.g. cycle-14)" },
    parent: { type: "string", description: "Parent issue ID for sub-issues" },
    assignee: { type: "string", description: "Assignee id (e.g. claude, sarah)" },
    "assignee-type": { type: "string", description: "agent | member (auto-detected)" },
    "assignee-model": { type: "string", description: "Model name for agent assignee" },
    state: { type: "string", description: "Initial state (default: backlog)" },
    github: { type: "string", description: "Linked GitHub issue/PR number" },
    description: { type: "string", description: "Initial description body" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();

      // Validate parent if given.
      let parent: string | null = null;
      if (args.parent) {
        const pid = stripAt(String(args.parent));
        try {
          await readIssue(root, pid);
          parent = pid;
        } catch {
          return err(ctx, "bad_parent", `parent issue ${pid} does not exist`);
        }
      }

      // Allocate ID. Sub-issues append .N to parent id (find next .N for this parent).
      let id: string;
      if (parent) {
        const { findNextChildId } = await import("../parent.js");
        id = await findNextChildId(root, parent);
      } else {
        const alloc = await allocateId(root);
        id = alloc.id;
      }

      const state = args.state ? parseState(String(args.state)) : "backlog";
      if (!state) {
        return err(ctx, "bad_state", `invalid state: ${args.state}`);
      }
      const assignee = parseAssignee(
        args.assignee ? String(args.assignee) : undefined,
        args["assignee-type"] as "agent" | "member" | undefined,
        args["assignee-model"] as string | undefined
      );
      const githubNum = args.github != null ? Number(args.github) : null;
      if (args.github != null && (githubNum === null || !Number.isInteger(githubNum))) {
        return err(ctx, "bad_github", `--github must be a positive integer`);
      }
      const labels = collectMulti(args.label);
      const now = new Date().toISOString();

      const issue: Issue = {
        id,
        title: String(args.title),
        state,
        parent,
        labels,
        assignee,
        github: githubNum && githubNum > 0 ? githubNum : null,
        cycle: args.cycle ? String(args.cycle) : null,
        created: now,
        updated: now,
        path: issuePath(root, id),
        sections: {
          description: args.description ? String(args.description) : "",
          acceptanceCriteria: [],
          activity: [],
          extra: "",
        },
        raw: "",
      };
      appendActivity(issue, detectWho(), `created`);
      await writeIssue(issue);
      await writeAgentContext(root);

      return ok(ctx, { id, path: issue.path }, () => renderIssue(issue));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "new_failed";
      return err(ctx, code, msg);
    }
  },
});

/** citty passes a repeated flag value as `string[]` when set multiple times. */
function collectMulti(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}
