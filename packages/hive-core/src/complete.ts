// Finishing work on an issue (design jira-sync §11.2): `hive ctl complete KEY`. It checks the work
// is ready — a clean tree, commits ahead of the base, the acceptance criteria ticked (or a note on
// why not), the workspace's `check` command passing — then hands it on by `on_complete`: open the
// PR (`pr`, the default), a draft (`draft_pr`), or only move the issue to review (`review`).
// Each check refuses with what to do about it; each step leaves an activity row.
import { PrError, baseBranch, baseRef, createPullRequest, run, workOf } from "./pr.js";
import { commentOnIssue, readConfig, readIssue, updateIssue } from "./storage.js";
import type { PrRef } from "./types.js";

export interface CompleteOptions {
  /** Where it runs: the agent's worktree, or anywhere the issue's worktree is found from. */
  cwd: string;
  /** Why some acceptance criteria are not ticked; without it, an unticked one refuses. */
  acNote?: string;
  /** Open a draft PR, whatever `on_complete` says. */
  draft?: boolean;
  /** The agent's summary of what it did, for the PR body. */
  summary?: string;
  base?: string;
  who: string;
}

export interface CompleteResult {
  id: string;
  mode: "pr" | "draft_pr" | "review";
  worktree: string;
  branch: string;
  base: string;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  pr?: PrRef;
  state: string;
  status?: string;
}

/** How long the workspace's `check` command may run. */
const CHECK_MS = 20 * 60_000;

export async function completeIssue(root: string, id: string, opts: CompleteOptions): Promise<CompleteResult> {
  const issue = await readIssue(root, id);
  const cfg = await readConfig(root);
  const work = await workOf(root, issue, opts.cwd);
  const base = await baseBranch(root, work.path, opts.base);

  const dirty = await run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: work.path });
  if (dirty.code !== 0) throw new PrError("failed", `git status failed in ${work.path}: ${dirty.stderr.trim()}`);
  if (dirty.stdout.trim()) {
    const files = dirty.stdout.trimEnd().split("\n");
    throw new PrError(
      "failed",
      `${work.path} has uncommitted changes (${files.length}): ${files.slice(0, 5).map((l) => l.slice(3)).join(", ")}${files.length > 5 ? ", …" : ""}`,
      `commit them as "${id}: …" (or ignore them in .gitignore), then run this again`,
    );
  }

  const ref = await baseRef(work.path, base);
  if (!ref) throw new PrError("failed", `the base branch ${base} is not here (neither origin/${base} nor ${base})`, `git fetch origin ${base}, or set pr_base in .hivemind/config.yaml, or pass --base`);
  const count = await run("git", ["rev-list", "--count", `${ref}..HEAD`], { cwd: work.path });
  const ahead = Number(count.stdout.trim()) || 0;
  if (ahead === 0) throw new PrError("failed", `${work.branch} has no commits ahead of ${ref}: there is nothing to hand on`, `commit the work as "${id}: …", then run this again`);

  const ac = issue.sections.acceptanceCriteria;
  const open = ac.map((a, i) => ({ ...a, i })).filter((a) => !a.done);
  const note = opts.acNote?.trim();
  if (open.length && !note) {
    throw new PrError(
      "failed",
      `${open.length} of ${ac.length} acceptance criteria are not ticked: ${open.map((a) => `[${a.i}] ${a.text}`).join("; ")}`,
      `tick each one done with \`hive ctl mark-acceptance ${id} <index>\`, or say why not with --ac-note "…"`,
    );
  }

  if (cfg.check) {
    const r = await run(cfg.check, [], { cwd: work.path, shell: true, timeoutMs: CHECK_MS });
    if (r.code !== 0) {
      const said = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-20).join("\n");
      throw new PrError("failed", `the check \`${cfg.check}\` failed (exit ${r.code}) in ${work.path}:\n${said}`, `make \`${cfg.check}\` pass, commit, then run this again`);
    }
  }

  const passed = [
    `${work.branch} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${ref}`,
    "the tree is clean",
    ac.length ? `acceptance ${ac.length - open.length}/${ac.length}${note ? ` (not all ticked: ${note})` : ""}` : null,
    cfg.check ? `\`${cfg.check}\` passed` : null,
  ].filter(Boolean);
  await commentOnIssue(root, id, `complete: ${passed.join(", ")}`, opts.who);
  if (!issue.branch) await updateIssue(root, id, { branch: work.branch }, opts.who);

  const mode = opts.draft ? "draft_pr" : (cfg.on_complete ?? "pr");
  const done = { id, mode, worktree: work.path, branch: work.branch, base, ahead } as const;
  if (mode === "review") {
    const after = await updateIssue(root, id, { state: "in_review" }, opts.who, "complete: handed on for review (on_complete: review, no PR)");
    return { ...done, state: after.state, ...(after.status ? { status: after.status } : {}) };
  }
  const pr = await createPullRequest(root, id, { cwd: work.path, base, draft: mode === "draft_pr", who: opts.who, ...(opts.summary ? { summary: opts.summary } : {}), ...(note ? { acNote: note } : {}) });
  const after = await readIssue(root, id);
  return { ...done, pr, state: after.state, ...(after.status ? { status: after.status } : {}) };
}
