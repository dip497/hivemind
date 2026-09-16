/**
 * `hive review` — the review comments a human left on a diff, which an agent
 * has no other way to reach. Reads `.hivemind/review.json` directly, so it
 * works whether or not the app is running.
 *
 *   hive review list [--file <p>] [--status open|resolved|all] [--json]
 *   hive review show <id> [--json]
 *   hive review reply <id> <message> [--json]
 *   hive review resolve <id> [--summary <why>] [--json]
 *   hive review reopen <id> [--json]
 *   hive review watch [--timeout <s>] [--json]     block until a new comment lands
 */
import { defineCommand } from "citty";
import {
  HiveError, listComments, readComments, replyTo, reopenComment, requireRoot, resolveComment,
  type ReviewComment,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { detectWho } from "../who.js";

const fail = (ctx: { json: boolean }, e: unknown, fallback: string): never =>
  err(ctx, e instanceof HiveError ? e.code : fallback, e instanceof Error ? e.message : String(e));

const idArg = { id: { type: "positional", required: true, description: "comment id (from `hive review list`)" } } as const;
const jsonArg = { json: { type: "boolean" } } as const;

const where = (c: ReviewComment): string =>
  `${c.file}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`;

const oneLine = (c: ReviewComment): string =>
  `${c.id.padEnd(18)} ${c.resolved ? "resolved" : "open    "} ${where(c).padEnd(32)} ${c.body.split("\n")[0]!.slice(0, 60)}`;

const detail = (c: ReviewComment): string =>
  [
    `${c.id}  ${c.resolved ? "resolved" : "open"}${c.summary ? ` — ${c.summary}` : ""}`,
    `${where(c)}  ${c.side}  by ${c.author} at ${c.at}`,
    "",
    c.body,
    ...(c.replies ?? []).flatMap((r) => ["", `  ${r.author} at ${r.at}:`, `  ${r.body.replace(/\n/g, "\n  ")}`]),
  ].join("\n");

const listCmd = defineCommand({
  meta: { name: "list", description: "List review comments (open by default)" },
  args: {
    file: { type: "string", description: "only this path" },
    status: { type: "string", description: "open | resolved | all (default open)" },
    ...jsonArg,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const status = args.status === "resolved" || args.status === "all" ? args.status : "open";
      const list = await listComments(await requireRoot(), { file: args.file || undefined, status });
      return ok(ctx, list, () =>
        list.length === 0 ? "no comments" : list.map(oneLine).join("\n"));
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const showCmd = defineCommand({
  meta: { name: "show", description: "Show one comment with its replies" },
  args: { ...idArg, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = (await readComments(await requireRoot())).find((x) => x.id === args.id);
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => detail(c));
    } catch (e) { return fail(ctx, e, "show_failed"); }
  },
});

const replyCmd = defineCommand({
  meta: { name: "reply", description: "Reply to a review comment" },
  args: {
    ...idArg,
    message: { type: "positional", required: true, description: "what to say" },
    ...jsonArg,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await replyTo(await requireRoot(), String(args.id), {
        author: detectWho(), body: String(args.message), at: new Date().toISOString(),
      });
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `replied to ${c.id}`);
    } catch (e) { return fail(ctx, e, "reply_failed"); }
  },
});

const resolveCmd = defineCommand({
  meta: { name: "resolve", description: "Mark a review comment resolved" },
  args: { ...idArg, summary: { type: "string", description: "how it was addressed" }, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await resolveComment(await requireRoot(), String(args.id), args.summary || undefined);
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `resolved ${c.id}`);
    } catch (e) { return fail(ctx, e, "resolve_failed"); }
  },
});

const reopenCmd = defineCommand({
  meta: { name: "reopen", description: "Reopen a resolved comment" },
  args: { ...idArg, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await reopenComment(await requireRoot(), String(args.id));
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `reopened ${c.id}`);
    } catch (e) { return fail(ctx, e, "reopen_failed"); }
  },
});

const WATCH_POLL_MS = 1000;
const WATCH_DEFAULT_S = 300;

/** Block until a comment appears that was not there when we started. This is
 *  what makes a review a loop: the agent waits for the human instead of
 *  being re-prompted. Exit 4 on timeout, like `hive ctl read`. */
const watchCmd = defineCommand({
  meta: { name: "watch", description: "Wait for the next review comment (exit 4 on timeout)" },
  args: {
    timeout: { type: "string", description: `seconds to wait (default ${WATCH_DEFAULT_S})` },
    file: { type: "string", description: "only this path" },
    ...jsonArg,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const filter = { file: args.file || undefined, status: "open" as const };
      const seen = new Set((await listComments(root, filter)).map((c) => c.id));
      const seconds = Number.parseInt(String(args.timeout ?? ""), 10);
      const deadline = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : WATCH_DEFAULT_S) * 1000;
      for (;;) {
        const fresh = (await listComments(root, filter)).filter((c) => !seen.has(c.id));
        if (fresh.length > 0) return ok(ctx, fresh, () => fresh.map(detail).join("\n\n"));
        if (Date.now() >= deadline) {
          process.exitCode = 4;
          return ok(ctx, [], () => "no new comments");
        }
        await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
      }
    } catch (e) { return fail(ctx, e, "watch_failed"); }
  },
});

export const reviewCmd = defineCommand({
  meta: { name: "review", description: "Review comments left on a diff" },
  subCommands: {
    list: listCmd, show: showCmd, reply: replyCmd,
    resolve: resolveCmd, reopen: reopenCmd, watch: watchCmd,
  },
});
