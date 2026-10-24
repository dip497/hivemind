/**
 * `hive pr create|status|sync|cleanup` and `hive ctl complete` (design jira-sync §11.2–§11.3): an
 * issue's pull request, through `gh` (hive keeps no GitHub token). Each runs from the issue's
 * worktree or anywhere its workspace is found from; a refusal says what to do (`fix`).
 */
import { defineCommand } from "citty";
import {
  HiveError, PrError, applyPrStates, cleanupWork, completeIssue, createPullRequest, fetchPrStates, followsPr, issueRootFrom,
  prStatus, readIssue, syncPullRequests, workOf, workspaceRootFrom, writeAgentContext, type PrChange,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { detectWho } from "../who.js";
import path from "node:path";

/** Who signs activity rows: the agent of the tile it runs in, else the person. */
const actor = (): string => process.env.HIVE_AGENT_ID || process.env.HIVE_ACTOR || detectWho();

type Ctx = { json: boolean };
function fail(ctx: Ctx, e: unknown): never {
  if (e instanceof PrError) return err(ctx, e.code, e.message, undefined, e.fix);
  if (e instanceof HiveError) return err(ctx, e.code, e.message);
  return err(ctx, "failed", (e as Error)?.message ?? String(e));
}

const keyArg = { id: { type: "positional", required: true, description: "the issue, e.g. PAY-42" } } as const;
const JSON_ARG = { json: { type: "boolean", description: "print the result as JSON on one line" } } as const;

const changeLine = (c: PrChange) => `${c.id}  ${c.pr.repo}#${c.pr.number} ${c.event}${c.movedTo ? ` → ${c.movedTo}` : ""}`;

export const completeCmd = defineCommand({
  meta: {
    name: "complete",
    description: "Finish work on an issue: check it (clean tree, commits ahead of the base, acceptance ticked or --ac-note, config.yaml's `check`), then hand it on by on_complete: push and open the PR (default), a draft, or move it to review",
  },
  args: {
    ...keyArg,
    "ac-note": { type: "string", description: "why some acceptance criteria are not ticked (otherwise they refuse)" },
    draft: { type: "boolean", description: "open the PR as a draft, whatever on_complete says" },
    summary: { type: "string", description: "what you did, for the PR body" },
    base: { type: "string", description: "the branch the PR targets (default: pr_base in config.yaml, else the remote's default)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const id = String(args.id);
      const root = await issueRootFrom(id, process.cwd());
      const r = await completeIssue(root, id, {
        cwd: process.cwd(),
        who: actor(),
        ...(args["ac-note"] ? { acNote: String(args["ac-note"]) } : {}),
        ...(args.draft ? { draft: true } : {}),
        ...(args.summary ? { summary: String(args.summary) } : {}),
        ...(args.base ? { base: String(args.base) } : {}),
      });
      await writeAgentContext(root).catch(() => {});
      return ok(ctx, r, () =>
        r.pr
          ? `${id}: ${r.pr.state === "draft" ? "draft PR" : "PR"} ${r.pr.url} — now ${r.status ?? r.state}`
          : `${id}: handed on for review (on_complete: review) — now ${r.status ?? r.state}`);
    } catch (e) { fail(ctx, e); }
  },
});

const create = defineCommand({
  meta: { name: "create", description: "Push the issue's branch and open its PR (title `KEY: title`; body: description, acceptance, tracker link); writes pr + github and moves the issue by local.onPrOpened" },
  args: {
    ...keyArg,
    draft: { type: "boolean", description: "open it as a draft" },
    base: { type: "string", description: "the branch the PR targets (default: pr_base, else the remote's default)" },
    summary: { type: "string", description: "what was done, for the PR body" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const id = String(args.id);
      const root = await issueRootFrom(id, process.cwd());
      const work = await workOf(root, await readIssue(root, id), process.cwd());
      const pr = await createPullRequest(root, id, {
        cwd: work.path,
        who: actor(),
        ...(args.draft ? { draft: true } : {}),
        ...(args.base ? { base: String(args.base) } : {}),
        ...(args.summary ? { summary: String(args.summary) } : {}),
      });
      await writeAgentContext(root).catch(() => {});
      return ok(ctx, pr, () => `${id}: ${pr.state === "draft" ? "draft PR" : "PR"} ${pr.url}`);
    } catch (e) { fail(ctx, e); }
  },
});

const status = defineCommand({
  meta: { name: "status", description: "What GitHub says of the issue's PR now: state, merged, review decision, checks (reads only; `hive pr sync` writes)" },
  args: { ...keyArg, ...JSON_ARG },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const id = String(args.id);
      const root = await issueRootFrom(id, process.cwd());
      const s = await prStatus(root, id, path.dirname(root));
      return ok(ctx, s, () => `${id}  ${s.pr.url}  ${[s.pr.state, s.pr.review?.replace("_", " "), s.pr.checks && `checks ${s.pr.checks}`].filter(Boolean).join(", ")}`);
    } catch (e) { fail(ctx, e); }
  },
});

const sync = defineCommand({
  meta: { name: "sync", description: "The PR watcher's pass, for scripts: every open PR of this workspace (or one issue's) in one gh call; merged → local.onPrMerged, closed → local.onPrClosed" },
  args: { id: { type: "positional", required: false, description: "only this issue" }, ...JSON_ARG },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      let changes: PrChange[];
      let root: string;
      if (args.id) {
        const id = String(args.id);
        root = await issueRootFrom(id, process.cwd());
        const issue = await readIssue(root, id);
        if (!issue.pr) throw new PrError("not_found", `${id} has no PR`, `hive pr create ${id}`);
        changes = followsPr(issue) ? await applyPrStates(root, [issue], await fetchPrStates([issue.pr], path.dirname(root))) : [];
      } else {
        root = await workspaceRootFrom(process.cwd());
        changes = await syncPullRequests(root);
      }
      if (changes.length) await writeAgentContext(root).catch(() => {});
      return ok(ctx, { changes }, () => changes.map(changeLine).join("\n") || "no PR changed");
    } catch (e) { fail(ctx, e); }
  },
});

const cleanup = defineCommand({
  meta: { name: "cleanup", description: "After the merge: remove the issue's worktree (kept if it has uncommitted changes) and its local branch" },
  args: { ...keyArg, ...JSON_ARG },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const id = String(args.id);
      const root = await issueRootFrom(id, process.cwd());
      const r = await cleanupWork(root, id, actor());
      return ok(ctx, r, () => [r.removed && `removed ${r.removed}`, r.branch && `deleted branch ${r.branch}`].filter(Boolean).join("; ") || "nothing to remove");
    } catch (e) { fail(ctx, e); }
  },
});

export const prCmd = defineCommand({
  meta: { name: "pr", description: "An issue's pull request through gh: create, status, sync (the watcher's pass), cleanup after the merge" },
  subCommands: { create, status, sync, cleanup },
});
