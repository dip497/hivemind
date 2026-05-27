import { defineCommand } from "citty";
import { HiveError, readIssue, requireRoot } from "@hivemind/core";
import { err, ok, renderIssue } from "../format.js";
import { stripAt } from "../parse.js";

export const showCmd = defineCommand({
  meta: {
    name: "show",
    description: "Show full body of an issue. Accepts ID or @ID.",
  },
  args: {
    id: { type: "positional", description: "Issue id (PAY-118 or @PAY-118)", required: true },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const id = stripAt(String(args.id));
      const issue = await readIssue(root, id);
      return ok(ctx, issue, () => renderIssue(issue));
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "show_failed";
      return err(ctx, code, msg);
    }
  },
});
