// Pull requests for issues (design jira-sync §11.3–§11.4), through `gh`: hive stores no GitHub
// token, and a remote tile's issue uses that machine's `gh`, the way `git` runs there (its agent's
// `hive` runs on that machine). Every program here runs without a terminal and with a timeout, so
// nothing waits on a prompt: a `gh` that is not signed in is a refusal that says how to sign in.
import { spawn } from "node:child_process";
import path from "node:path";
import { HiveError, commentOnIssue, findRoot, listIssues, locateIssue, readConfig, readIssue, requireRoot, updateIssue } from "./storage.js";
import { rootForIdHere } from "./json.js";
import { defaultStatus, isBuiltinWorkflow, issueTypeOf, loadWorkflow } from "./workflow.js";
import type { IssueState, Issue, IssueSummary, PrRef } from "./types.js";

export interface CreatePrOptions {
  draft?: boolean;
  /** Default: `pr_base` in config.yaml, else the repo's default branch. */
  base?: string;
  /** The worktree (or checkout) whose branch is pushed. */
  cwd: string;
  /** The agent's completion summary, put in the PR body. */
  summary?: string;
  /** Why some acceptance criteria are not ticked (`hive ctl complete --ac-note`), put in the PR body. */
  acNote?: string;
  /** Who signs the issue's activity rows. */
  who?: string;
}

/** A change the watcher (or `hive pr sync`) saw for one issue's PR. */
export interface PrChange {
  id: string;
  pr: PrRef;
  event: "merged" | "closed" | "changes-requested" | "checks-failing" | "reopened";
  /** The status the issue moved to (by `workflow.local`), when it moved. */
  movedTo?: string;
}

/** A refusal with what to do about it; `code` is an exit-code name the CLI knows (exit-codes.ts). */
export class PrError extends HiveError {
  constructor(code: string, message: string, public fix?: string) {
    super(code, message);
    this.name = "PrError";
  }
}

// ── running git and gh ─────────────────────────────────────────────────────────────────────────

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** The program is not installed (not on PATH). */
  missing?: boolean;
}

/** No program here may ask a question on a terminal: there is none. */
const QUIET_ENV = { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" };

/** Run `bin args` in `cwd` (no shell unless `shell`), its stdin `input` or closed, killed after `timeoutMs`. */
export function run(bin: string, args: string[], opts: { cwd: string; input?: string; timeoutMs?: number; shell?: boolean }): Promise<Ran> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...QUIET_ENV }, shell: opts.shell ?? false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String((e as Error).message), missing: true });
      return;
    }
    const timer = setTimeout(() => { err += `\n${bin} took longer than ${Math.round((opts.timeoutMs ?? 60_000) / 1000)}s and was stopped`; child.kill("SIGKILL"); }, opts.timeoutMs ?? 60_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: out, stderr: e.message, missing: e.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

const git = (cwd: string, args: string[], timeoutMs = 30_000) => run("git", args, { cwd, timeoutMs });
const gh = (cwd: string, args: string[], input?: string, timeoutMs = 60_000) => run("gh", args, { cwd, timeoutMs, ...(input === undefined ? {} : { input }) });
/** The last lines of what a program said, for a refusal. */
const tail = (r: Ran, lines = 12): string => (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-lines).join("\n");
const ok = async (p: Promise<Ran>): Promise<string | null> => { const r = await p; return r.code === 0 ? r.stdout.trim() : null; };

// ── where an issue's work is ───────────────────────────────────────────────────────────────────

/**
 * The workspace that holds `id`, from `cwd`: as every command finds it, except that from inside a
 * linked git worktree whose own `.hivemind` (a tracked config) lacks the issue, the main checkout's
 * workspace is the one — the issues live there, and an agent finishing work runs in the worktree.
 */
export async function issueRootFrom(id: string, cwd: string): Promise<string> {
  const here = await rootForIdHere(id, cwd).catch((e) => e as Error);
  if (typeof here === "string" && (await locateIssue(here, id))) return here;
  const common = await ok(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (common) {
    const main = await findRoot(path.dirname(common));
    if (main && main !== here && (await locateIssue(main, id))) return main;
  }
  if (typeof here === "string") return here;
  throw here;
}

/** The workspace a command over every issue acts on from `cwd`: from a linked git worktree, the
 *  main checkout's (where the issues live) when it has one; else the one `cwd` is in. */
export async function workspaceRootFrom(cwd: string): Promise<string> {
  const [common, top] = await Promise.all([
    ok(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    ok(git(cwd, ["rev-parse", "--show-toplevel"])),
  ]);
  if (common && top && path.resolve(path.dirname(common)) !== path.resolve(top)) {
    const main = await findRoot(path.dirname(common));
    if (main) return main;
  }
  return requireRoot(cwd);
}

/** Each worktree of the repository at `cwd`, with the branch it has checked out. */
export async function worktrees(cwd: string): Promise<{ path: string; branch: string | null }[]> {
  const out = await ok(git(cwd, ["worktree", "list", "--porcelain"]));
  if (out === null) return [];
  return out.split(/\n\n+/).flatMap((block) => {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) return [];
    const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    return [{ path: wt, branch: b }];
  });
}

/** The branch checked out at `cwd`; null when detached or not a repository. */
export const currentBranch = (cwd: string): Promise<string | null> => ok(git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));

/** The base a PR targets: `base`, else `pr_base`, else the remote's default branch, else `main`. */
export async function baseBranch(root: string, cwd: string, base?: string): Promise<string> {
  if (base) return base;
  const cfg = await readConfig(root);
  if (cfg.pr_base) return cfg.pr_base;
  const head = await ok(git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]));
  return head ? head.replace(/^origin\//, "") : "main";
}

/**
 * The checkout an issue's work is in. With `branch:` on the issue: `cwd` when it has that branch
 * checked out, else the worktree that has. Without: `cwd`'s checkout, when it is on a branch other
 * than the base (the branch is then the issue's).
 */
export async function workOf(root: string, issue: Issue, cwd: string): Promise<{ path: string; branch: string }> {
  const top = await ok(git(cwd, ["rev-parse", "--show-toplevel"]));
  if (issue.branch) {
    if (top && (await currentBranch(top)) === issue.branch) return { path: top, branch: issue.branch };
    for (const from of [top, path.dirname(root)]) {
      if (!from) continue;
      const wt = (await worktrees(from)).find((w) => w.branch === issue.branch);
      if (wt) return { path: wt.path, branch: issue.branch };
    }
    throw new PrError(
      "not_found",
      `${issue.id}'s branch ${issue.branch} is not checked out in any worktree of ${top ?? path.dirname(root)}`,
      `run it from the checkout of ${issue.branch}, or check it out: git worktree add ../${issue.branch} ${issue.branch}`,
    );
  }
  if (!top) throw new PrError("not_found", `${issue.id} names no branch and ${cwd} is not in a git repository`, `run it from the checkout the work is in`);
  const branch = await currentBranch(top);
  const base = await baseBranch(root, top);
  if (!branch || branch === base) {
    throw new PrError(
      "failed",
      `${issue.id} names no branch and ${top} is on ${branch ?? "a detached HEAD"}: the work needs a branch of its own`,
      `git switch -c ${issue.id}-<short-name>, commit the work as "${issue.id}: …", then run this again`,
    );
  }
  return { path: top, branch };
}

/** A `git` ref for `base` that exists here: the remote's copy first (what the PR compares with). */
export async function baseRef(cwd: string, base: string): Promise<string | null> {
  for (const ref of [`origin/${base}`, base]) {
    if ((await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
  }
  return null;
}

// ── workflow.local ─────────────────────────────────────────────────────────────────────────────

type LocalRule = "onPrOpened" | "onPrMerged" | "onPrClosed";
/** Where each rule lands when the workflow names none (design §4.2's example, and today's states). */
const RULE_DEFAULT: Record<LocalRule, IssueState> = { onPrOpened: "in_review", onPrMerged: "done", onPrClosed: "in_progress" };

/** The status an issue moves to by `local.<rule>`: a status id, or `category:<state>` = that
 *  category's default status for the issue's type. As a patch `updateIssue` takes. */
export function localTarget(root: string, issue: Pick<Issue, "state" | "external">, rule: LocalRule): { status: string } | { state: IssueState } {
  const wf = loadWorkflow(root);
  const named = wf.local[rule];
  const category = named?.startsWith("category:") ? (named.slice("category:".length) as IssueState) : named ? null : RULE_DEFAULT[rule];
  if (!category) return { status: named! };
  if (isBuiltinWorkflow(wf)) return { state: category };
  const s = defaultStatus(wf, category, issueTypeOf(wf, issue)) ?? defaultStatus(wf, category);
  return s ? { status: s.id } : { state: category };
}

// ── creating a PR ──────────────────────────────────────────────────────────────────────────────

/** `owner/repo` and the PR number from a PR's URL (`https://github.com/o/r/pull/12`). */
export function parsePrUrl(url: string): { host: string; repo: string; number: number } | null {
  const m = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { host: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

/** The GitHub host of a remote's URL (`git@github.com:o/r.git`, `https://ghe.corp/o/r`). */
function hostOfRemote(url: string): string | null {
  return /^[\w.-]+@([^:/]+):/.exec(url)?.[1] ?? /^\w+:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url)?.[1] ?? null;
}

/** The PR body: the issue's description, its acceptance checklist, the tracker link and the
 *  agent's summary. */
export function prBody(issue: Issue, opts: { summary?: string; acNote?: string }): string {
  const parts: string[] = [];
  const description = issue.sections.description.trim();
  if (description) parts.push(description.length > 4000 ? `${description.slice(0, 4000)}…` : description);
  const ac = issue.sections.acceptanceCriteria;
  if (ac.length) {
    parts.push(`## Acceptance criteria\n\n${ac.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n")}${opts.acNote ? `\n\nNot all ticked: ${opts.acNote}` : ""}`);
  }
  if (opts.summary?.trim()) parts.push(`## Summary\n\n${opts.summary.trim()}`);
  const tracker = issue.external?.url ? `[${issue.external.key}](${issue.external.url})` : null;
  parts.push(`---\nhive issue ${issue.id}${tracker ? ` · tracker: ${tracker}` : ""}`);
  return parts.join("\n\n");
}

/** Refuse, after moving the issue to review with a note, when `gh` cannot open a PR here. */
async function needGh(root: string, issue: Issue, cwd: string, who: string): Promise<void> {
  const remote = await ok(git(cwd, ["remote", "get-url", "origin"]));
  const host = (remote && hostOfRemote(remote)) || "github.com";
  const r = await gh(cwd, ["auth", "status", "--hostname", host], undefined, 20_000);
  if (r.code === 0) return;
  const why = r.missing ? "the GitHub CLI (gh) is not installed" : `gh is not signed in to ${host}`;
  const fix = r.missing ? "install gh (https://cli.github.com), run `gh auth login`, then run this again" : `gh auth login --hostname ${host}, then run this again`;
  const note = `PR not opened: ${why}. Moved to review instead; ${fix.replace(/^./, (c) => c.toLowerCase())}.`;
  await updateIssue(root, issue.id, { state: "in_review" }, who, note);
  throw new PrError("forbidden", `${why}; ${issue.id} moved to review without a PR`, fix);
}

/** Push the issue's branch and open its PR; write `pr` and `github`, then move the issue to
 *  `local.onPrOpened`. An open PR for the branch is reused (pushed to again), never doubled. */
export async function createPullRequest(root: string, id: string, opts: CreatePrOptions): Promise<PrRef> {
  const who = opts.who ?? "hive";
  const issue = await readIssue(root, id);
  const branch = await currentBranch(opts.cwd);
  if (!branch) throw new PrError("failed", `${opts.cwd} is not on a branch`, `check out ${issue.branch ?? `the branch of ${id}`} there`);
  const base = await baseBranch(root, opts.cwd, opts.base);
  if (branch === base) throw new PrError("failed", `${opts.cwd} is on ${base}, the base: a PR needs a branch of its own`, `git switch -c ${id}-<short-name>`);
  await needGh(root, issue, opts.cwd, who);

  const remote = (await ok(git(opts.cwd, ["config", `branch.${branch}.remote`]))) || (await ok(git(opts.cwd, ["config", "remote.pushDefault"]))) || "origin";
  const pushed = await git(opts.cwd, ["push", "-u", remote, `HEAD:refs/heads/${branch}`], 180_000);
  if (pushed.code !== 0) throw new PrError("failed", `git push to ${remote} failed:\n${tail(pushed)}`, `fix the push (git push -u ${remote} ${branch}), then run this again`);
  await commentOnIssue(root, id, `pushed ${branch} to ${remote}`, who);

  let pr: PrRef | null = null;
  let reused = false;
  const existing = await gh(opts.cwd, ["pr", "view", branch, "--json", "number,url,state,isDraft"]);
  if (existing.code === 0) {
    const j = JSON.parse(existing.stdout) as { number: number; url: string; state: string; isDraft: boolean };
    const at = parsePrUrl(j.url);
    if (at && j.state === "OPEN") {
      pr = { repo: at.repo, number: j.number, url: j.url, state: j.isDraft ? "draft" : "open" };
      reused = true;
    }
  }
  if (!pr) {
    const args = ["pr", "create", "--head", branch, "--base", base, "--title", `${id}: ${issue.title}`, "--body-file", "-", ...(opts.draft ? ["--draft"] : [])];
    const made = await gh(opts.cwd, args, prBody(issue, opts), 120_000);
    const url = made.stdout.trim().split("\n").reverse().find((l) => parsePrUrl(l));
    const at = url ? parsePrUrl(url) : null;
    if (made.code !== 0 || !at || !url) throw new PrError("failed", `gh pr create failed:\n${tail(made)}`, `see what gh said, fix it, then run this again (the branch is pushed)`);
    pr = { repo: at.repo, number: at.number, url: url.trim(), state: opts.draft ? "draft" : "open" };
  }
  await updateIssue(
    root,
    id,
    { pr, github: pr.number, ...(issue.branch ? {} : { branch }), ...localTarget(root, issue, "onPrOpened") },
    who,
    `${reused ? "pushed to the open PR" : "opened PR"} ${pr.repo}#${pr.number}${pr.state === "draft" ? " (draft)" : ""}: ${pr.url}`,
  );
  return pr;
}

// ── reading PRs ────────────────────────────────────────────────────────────────────────────────

/** What GitHub says of one PR right now (`hive pr status`). */
export interface PrStatus {
  pr: PrRef;
  mergedAt: string | null;
  reviewDecision: string | null;
  statusCheckRollup: unknown[];
}

/** `gh pr view` of the issue's PR, as GitHub has it now. Reads only. */
export async function prStatus(root: string, id: string, cwd: string): Promise<PrStatus> {
  const issue = await readIssue(root, id);
  if (!issue.pr) throw new PrError("not_found", `${id} has no PR`, `open one: hive pr create ${id}`);
  const r = await gh(cwd, ["pr", "view", issue.pr.url, "--json", "state,isDraft,mergedAt,reviewDecision,statusCheckRollup,url,number"]);
  if (r.code !== 0) throw new PrError(r.missing ? "forbidden" : "failed", `gh pr view failed:\n${tail(r)}`, r.missing ? "install gh (https://cli.github.com) and run `gh auth login`" : "gh auth status");
  const j = JSON.parse(r.stdout) as { state: string; isDraft: boolean; mergedAt: string | null; reviewDecision: string | null; statusCheckRollup: { conclusion?: string; state?: string; status?: string }[] | null; url: string; number: number };
  const seen = stateOf({ state: j.state, isDraft: j.isDraft, merged: !!j.mergedAt, reviewDecision: j.reviewDecision, rollup: rollupOf(j.statusCheckRollup ?? []) });
  return { pr: { ...issue.pr, ...seen }, mergedAt: j.mergedAt, reviewDecision: j.reviewDecision, statusCheckRollup: j.statusCheckRollup ?? [] };
}

/** The checks of `gh pr view`'s rollup (one entry per check run or status) as one state. */
function rollupOf(items: { conclusion?: string; state?: string; status?: string }[]): string | null {
  if (!items.length) return null;
  const each = items.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
  if (each.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "FAILURE";
  if (each.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s))) return "SUCCESS";
  return "PENDING";
}

/** GitHub's words for a PR, as `PrRef` keeps them. */
function stateOf(g: { state: string; isDraft: boolean; merged: boolean; reviewDecision: string | null; rollup: string | null }): Pick<PrRef, "state" | "review" | "checks"> {
  const state: PrRef["state"] = g.merged || g.state === "MERGED" ? "merged" : g.state === "CLOSED" ? "closed" : g.isDraft ? "draft" : "open";
  const review = ({ APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" } as const)[g.reviewDecision ?? ""];
  const checks = ({ SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" } as const)[g.rollup ?? ""];
  return { state, ...(review ? { review } : {}), ...(checks ? { checks } : {}) };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * What GitHub says of each PR, by URL, in one `gh api graphql` call per GitHub host (one, almost
 * always): the PRs are aliased fields of one query. A PR GitHub did not answer for is left out.
 */
export async function fetchPrStates(prs: PrRef[], cwd: string): Promise<Map<string, Pick<PrRef, "state" | "review" | "checks">>> {
  const out = new Map<string, Pick<PrRef, "state" | "review" | "checks">>();
  const byHost = new Map<string, PrRef[]>();
  for (const pr of prs) {
    const at = parsePrUrl(pr.url);
    if (!at || !REPO_RE.test(pr.repo) || !Number.isInteger(pr.number)) continue;
    byHost.set(at.host, [...(byHost.get(at.host) ?? []), pr]);
  }
  for (const [host, list] of byHost) {
    const repos = [...new Set(list.map((p) => p.repo))];
    const fields = repos.map((repo, i) => {
      const [owner, name] = repo.split("/");
      const nums = [...new Set(list.filter((p) => p.repo === repo).map((p) => p.number))];
      const prsQ = nums.map((n) => `p${n}: pullRequest(number: ${n}) { url state isDraft merged reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`).join(" ");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prsQ} }`;
    });
    const r = await gh(cwd, ["api", "graphql", "--hostname", host, "-f", `query=query { ${fields.join(" ")} }`]);
    // A PR that is gone (deleted repo, no access) makes GitHub answer `errors` beside the rest.
    let data: Record<string, Record<string, GqlPr | null> | null> = {};
    try {
      data = (JSON.parse(r.stdout) as { data?: typeof data }).data ?? {};
    } catch {
      if (r.code !== 0) throw new PrError(r.missing ? "forbidden" : "failed", `gh api graphql (${host}) failed: ${tail(r, 4)}`, r.missing ? "install gh (https://cli.github.com) and run `gh auth login`" : `gh auth login --hostname ${host}`);
    }
    for (const repo of Object.values(data)) {
      for (const p of Object.values(repo ?? {})) {
        if (!p?.url) continue;
        const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
        out.set(p.url, stateOf({ state: p.state, isDraft: p.isDraft, merged: p.merged, reviewDecision: p.reviewDecision, rollup }));
      }
    }
  }
  return out;
}

interface GqlPr {
  url: string;
  state: string;
  isDraft: boolean;
  merged: boolean;
  reviewDecision: string | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state: string } | null } }[] };
}

/** An issue whose PR the watcher follows. */
export const followsPr = (i: Pick<IssueSummary, "pr">): boolean => i.pr?.state === "open" || i.pr?.state === "draft";

/**
 * Write what GitHub said (`seen`, by URL) on each issue of `root` whose PR it answered for: merged
 * → `local.onPrMerged`, closed unmerged → `local.onPrClosed` with a note, changes requested and
 * failing checks → only the PR's badges. An issue whose PR did not change is not written.
 */
export async function applyPrStates(root: string, issues: Pick<IssueSummary, "id" | "pr">[], seen: Map<string, Pick<PrRef, "state" | "review" | "checks">>, who = "github"): Promise<PrChange[]> {
  const changes: PrChange[] = [];
  for (const { id } of issues) {
    let issue: Issue;
    try {
      issue = await readIssue(root, id);
    } catch {
      continue; // deleted since it was listed
    }
    const before = issue.pr;
    const now = before && seen.get(before.url);
    if (!before || !now || !followsPr(issue)) continue;
    const pr: PrRef = { ...before, state: now.state };
    delete pr.review;
    delete pr.checks;
    if (now.review) pr.review = now.review;
    if (now.checks) pr.checks = now.checks;
    if (JSON.stringify(pr) === JSON.stringify(before)) continue;
    const name = `${pr.repo}#${pr.number}`;
    if (pr.state === "merged" || pr.state === "closed") {
      const merged = pr.state === "merged";
      const to = localTarget(root, issue, merged ? "onPrMerged" : "onPrClosed");
      const after = await updateIssue(root, id, { pr, ...to }, who, merged ? `PR ${name} merged` : `PR ${name} was closed without merging`);
      changes.push({ id, pr, event: merged ? "merged" : "closed", movedTo: after.status ?? after.state });
      continue;
    }
    await updateIssue(root, id, { pr }, who);
    if (pr.review === "changes_requested" && before.review !== "changes_requested") changes.push({ id, pr, event: "changes-requested" });
    if (pr.checks === "failing" && before.checks !== "failing") changes.push({ id, pr, event: "checks-failing" });
  }
  return changes;
}

/** One pass over every issue with an open PR, batched in one `gh api graphql` call. */
export async function syncPullRequests(root: string): Promise<PrChange[]> {
  const open = (await listIssues(root)).filter(followsPr);
  if (!open.length) return [];
  const seen = await fetchPrStates(open.map((i) => i.pr!), path.dirname(root));
  return applyPrStates(root, open, seen);
}

// ── after a merge ──────────────────────────────────────────────────────────────────────────────

/**
 * Remove a merged issue's worktree and its local branch. The main checkout is never removed, and a
 * worktree with uncommitted changes is kept (git refuses; the refusal says so).
 */
export async function cleanupWork(root: string, id: string, who = "hive"): Promise<{ removed: string | null; branch: string | null }> {
  const issue = await readIssue(root, id);
  if (issue.pr?.state !== "merged") throw new PrError("failed", `${id}'s PR is ${issue.pr ? issue.pr.state : "not opened"}: only merged work is cleaned up`, issue.pr ? `hive pr sync, once it is merged` : `hive pr create ${id}`);
  if (!issue.branch) return { removed: null, branch: null };
  // From the issue's file, and about to be an argument: never an option.
  if (issue.branch.startsWith("-")) throw new PrError("bad_request", `${id}'s branch "${issue.branch}" is not a branch name`);
  const repo = path.dirname(root);
  const all = await worktrees(repo);
  const main = all[0]?.path;
  const wt = all.find((w) => w.branch === issue.branch && w.path !== main);
  let removed: string | null = null;
  if (wt) {
    const r = await git(repo, ["worktree", "remove", wt.path]);
    if (r.code !== 0) throw new PrError("failed", `git worktree remove ${wt.path} refused:\n${tail(r)}`, `commit or discard what is left there, then run this again`);
    removed = wt.path;
  }
  const checkedOut = all.some((w) => w.branch === issue.branch && w.path === main);
  let branch: string | null = null;
  // GitHub said it is merged (a squash merge leaves the local branch "unmerged" to git), so -D.
  if (!checkedOut && (await git(repo, ["branch", "-D", issue.branch])).code === 0) branch = issue.branch;
  await commentOnIssue(root, id, `cleaned up after the merge:${removed ? ` removed the worktree ${removed}` : ""}${branch ? `${removed ? ";" : ""} deleted the local branch ${branch}` : ""}${!removed && !branch ? " nothing to remove" : ""}`, who);
  return { removed, branch };
}
