import { defineCommand } from "citty";
import {
  HiveError,
  createIssue,
  readIssue,
  requireRoot,
  writeAgentContext,
} from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { detectWho } from "../who.js";
import { collectMulti, parseAssignee, parseState, stripAt } from "../parse.js";

export const newCmd = defineCommand({
  meta: {
    name: "new",
    description: "Create a new issue. Title is required.",
  },
  args: {
    title: { type: "positional", description: "Issue title", required: true },
    label: { type: "string", description: "Label (repeatable)" },
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

      // Route through core — it owns id allocation (incl. the next sub-issue id
      // under `parent`), the default body, and the canonical activity format.
      const issue = await createIssue(root, {
        title: String(args.title),
        state,
        parent: parent ?? undefined,
        labels: collectMulti(args.label),
        assignee,
        github: githubNum && githubNum > 0 ? githubNum : null,
        description: args.description ? String(args.description) : "",
        who: detectWho(),
      });
      await writeAgentContext(root);

      return ok(ctx, { id: issue.id, path: issue.path }, () => renderIssue(issue));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "new_failed";
      return err(ctx, code, msg);
    }
  },
});
