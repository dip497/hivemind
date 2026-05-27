/**
 * `hive resolve` expands @ID mentions in a text blob (read from arg or stdin).
 * Returns the original text with each @ID replaced by "[ID](.hivemind/issues/...)"
 * — useful for commit messages and PR descriptions.
 *
 * `hive @ID` is a top-level alias for `hive show ID`.
 */
import { defineCommand } from "citty";
import path from "node:path";
import {
  HiveError,
  issuePath,
  readIssue,
  requireRoot,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { extractMentions } from "../parse.js";

export const resolveCmd = defineCommand({
  meta: {
    name: "resolve",
    description: "Expand @ID mentions in text (arg or stdin) to markdown links",
  },
  args: {
    text: { type: "positional", description: "Text (omit to read stdin)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      let text = args.text != null ? String(args.text) : "";
      if (!text && !process.stdin.isTTY) {
        text = await readStdin();
      }
      if (!text) {
        return err(ctx, "no_input", `provide text as argument or via stdin`);
      }
      const mentions = extractMentions(text);
      let out = text;
      const expanded: Array<{ id: string; title: string }> = [];
      for (const id of mentions) {
        try {
          const issue = await readIssue(root, id);
          const relPath = path.relative(process.cwd(), issuePath(root, id));
          // Replace `@ID` (word-bounded) with `[ID — title](relPath)`.
          const re = new RegExp(`@${id.replace(/\./g, "\\.")}(?![A-Za-z0-9.-])`, "g");
          out = out.replace(re, `[${id} — ${issue.title}](${relPath})`);
          expanded.push({ id, title: issue.title });
        } catch {
          // Leave unresolvable mentions untouched.
        }
      }
      return ok(ctx, { text: out, expanded }, () => out);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "resolve_failed";
      return err(ctx, code, msg);
    }
  },
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
