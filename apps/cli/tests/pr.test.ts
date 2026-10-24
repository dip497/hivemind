/** `hive ctl complete` and `hive pr` (design jira-sync §11.2–§11.3) against a real git repository
 *  with a local bare remote, a worktree for the issue's branch, and the `gh` shim
 *  (scripts/gh-shim) on PATH: every check refuses with its fix, each on_complete mode does what it
 *  says, and `hive pr sync` moves the issue when GitHub says the PR merged or closed. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIssue, readIssue, updateIssue, writeConfig } from "@hivemind/core";
import { hive } from "./helpers.js";

// Each test runs several `hive` and `git` processes: seconds each on a loaded machine.
setDefaultTimeout(30_000);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-pr-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const SHIM = path.resolve(import.meta.dir, "../../../scripts/gh-shim");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();

let n = 0;
interface Setup { repo: string; root: string; wt: string; origin: string; shim: string; id: string }

/** A repository whose `.hivemind/config.yaml` is tracked (so the worktree has one too, without the
 *  issues), pushed to a bare origin; issue TT-1 on branch TT-1-widgets, checked out in a worktree
 *  with one commit. */
async function setup(o: { config?: Record<string, unknown>; ac?: boolean; workflow?: string; commit?: boolean } = {}): Promise<Setup> {
  const base = path.join(tmp, `s${n++}`);
  const origin = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const wt = path.join(base, "wt");
  const shim = path.join(base, "shim");
  fs.mkdirSync(shim, { recursive: true });
  fs.mkdirSync(path.join(repo, ".hivemind", "issues"), { recursive: true });
  git(base, "init", "-q", "--bare", origin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  const root = path.join(repo, ".hivemind");
  await writeConfig(root, { prefix: "TT", next_id: 1, agents: {}, ...o.config } as never);
  if (o.workflow) fs.writeFileSync(path.join(root, "workflow.yaml"), o.workflow);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".hivemind/*\n!.hivemind/config.yaml\n");
  fs.writeFileSync(path.join(repo, "README.md"), "widgets\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  const issue = await createIssue(root, {
    title: "Add widgets",
    description: "Widgets for everyone.",
    acceptanceCriteria: [{ done: !!o.ac, text: "widgets render" }, { done: !!o.ac, text: "widgets save" }],
    state: "in_progress",
    branch: "TT-1-widgets",
  });
  git(repo, "worktree", "add", "-q", "-b", "TT-1-widgets", wt);
  if (o.commit !== false) {
    fs.writeFileSync(path.join(wt, "widgets.ts"), "export const widgets = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "TT-1: widgets");
  }
  return { repo, root, wt, origin, shim, id: issue.id };
}

const run = (s: Setup, args: string[], cwd = s.wt) =>
  hive(args, { cwd, env: { XDG_CONFIG_HOME: path.join(s.shim, "..", "xdg"), HIVE_AGENT_ID: "tester", GH_SHIM: s.shim, PATH: `${SHIM}${path.delimiter}${process.env.PATH}` } });
/** Each `gh` call the shim saw, as its argv. */
const ghCalls = (s: Setup): string[][] =>
  fs.existsSync(path.join(s.shim, "calls")) ? fs.readFileSync(path.join(s.shim, "calls"), "utf8").trimEnd().split("\n").map((l) => l.split("\x1f").slice(0, -1)) : [];
const remoteBranches = (s: Setup) => git(s.origin, "branch", "--format=%(refname:short)").split("\n");
const err = (r: { json: unknown }) => (r.json as { error: { code: string; message: string; fix?: string } }).error;

describe("hive ctl complete: the checks", () => {
  test("uncommitted changes refuse, naming them, and nothing is pushed or opened", async () => {
    const s = await setup({ ac: true });
    fs.writeFileSync(path.join(s.wt, "loose.ts"), "x\n");
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, err(r).code]).toEqual([1, "FAILED"]);
    expect(err(r).message).toContain("loose.ts");
    expect(err(r).fix).toContain(`commit them as "${s.id}: …"`);
    expect(ghCalls(s)).toEqual([]);
    expect(remoteBranches(s)).toEqual(["main"]);
    expect((await readIssue(s.root, s.id)).state).toBe("in_progress");
  });

  test("a branch with no commits ahead of the base refuses", async () => {
    const s = await setup({ ac: true, commit: false });
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, err(r).message]).toEqual([1, expect.stringContaining("no commits ahead of origin/main")]);
    expect(ghCalls(s)).toEqual([]);
  });

  test("unticked acceptance criteria refuse without --ac-note, and pass with one, which the PR body carries", async () => {
    const s = await setup();
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, err(r).message]).toEqual([1, expect.stringContaining("2 of 2 acceptance criteria are not ticked: [0] widgets render; [1] widgets save")]);
    expect(err(r).fix).toContain(`hive ctl mark-acceptance ${s.id} <index>`);
    expect(ghCalls(s)).toEqual([]);
    const ok = run(s, ["ctl", "complete", s.id, "--ac-note", "saving is TT-2", "--json"]);
    expect(ok.code).toBe(0);
    expect(fs.readFileSync(path.join(s.shim, "body.md"), "utf8")).toContain("- [ ] widgets save\n\nNot all ticked: saving is TT-2");
  });

  test("config.yaml's check runs in the worktree; failing, it refuses with what it printed", async () => {
    const s = await setup({ ac: true, config: { check: "test -f widgets.ts && echo 'widgets: 1 failing' && exit 3" } });
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, err(r).message]).toEqual([1, expect.stringContaining("failed (exit 3)")]);
    expect(err(r).message).toContain("widgets: 1 failing");
    expect(ghCalls(s)).toEqual([]);
    expect(remoteBranches(s)).toEqual(["main"]);
  });
});

describe("hive ctl complete: on_complete", () => {
  test("pr (the default), from inside the worktree with only the key: pushes, opens the PR, moves to review, and says each step", async () => {
    const s = await setup({ ac: true });
    const r = run(s, ["ctl", "complete", s.id, "--summary", "Added widgets.ts", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ id: s.id, mode: "pr", branch: "TT-1-widgets", base: "main", ahead: 1, state: "in_review", pr: { repo: "acme/widgets", number: 7, state: "open" } });
    expect(remoteBranches(s).sort()).toEqual(["TT-1-widgets", "main"]);
    const create = ghCalls(s).find((c) => c[0] === "pr" && c[1] === "create")!;
    expect(create).toEqual(["pr", "create", "--head", "TT-1-widgets", "--base", "main", "--title", "TT-1: Add widgets", "--body-file", "-"]);
    const body = fs.readFileSync(path.join(s.shim, "body.md"), "utf8");
    expect(body).toContain("Widgets for everyone.");
    expect(body).toContain("- [x] widgets render");
    expect(body).toContain("## Summary\n\nAdded widgets.ts");
    const issue = await readIssue(s.root, s.id);
    expect([issue.state, issue.github, issue.pr]).toEqual(["in_review", 7, { repo: "acme/widgets", number: 7, url: "https://github.com/acme/widgets/pull/7", state: "open" }]);
    const rows = issue.sections.activity.map((a) => `${a.who}: ${a.message}`).join("\n");
    expect(rows).toContain("tester: complete: TT-1-widgets is 1 commit ahead of origin/main, the tree is clean, acceptance 2/2");
    expect(rows).toContain("tester: pushed TT-1-widgets to origin");
    expect(rows).toContain("tester: opened PR acme/widgets#7: https://github.com/acme/widgets/pull/7");
  });

  test("an open PR for the branch is pushed to again, not opened twice", async () => {
    const s = await setup({ ac: true });
    fs.writeFileSync(path.join(s.shim, "pr-view.json"), JSON.stringify({ number: 4, url: "https://github.com/acme/widgets/pull/4", state: "OPEN", isDraft: false }));
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, (r.json as { pr: { number: number } }).pr.number]).toEqual([0, 4]);
    expect(ghCalls(s).some((c) => c[1] === "create")).toBe(false);
  });

  test("draft_pr, or --draft, opens a draft", async () => {
    for (const how of [{ config: { on_complete: "draft_pr" } }, { flag: "--draft" }] as const) {
      const s = await setup({ ac: true, ...("config" in how ? { config: how.config } : {}) });
      const r = run(s, ["ctl", "complete", s.id, ...("flag" in how ? [how.flag] : []), "--json"]);
      expect([r.code, (r.json as { mode: string }).mode]).toEqual([0, "draft_pr"]);
      expect(ghCalls(s).find((c) => c[1] === "create")).toContain("--draft");
      expect((await readIssue(s.root, s.id)).pr?.state).toBe("draft");
    }
  });

  test("review: no push and no PR, the issue moves to the in_review category", async () => {
    const s = await setup({ ac: true, config: { on_complete: "review" } });
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, (r.json as { mode: string }).mode]).toEqual([0, "review"]);
    expect(ghCalls(s)).toEqual([]);
    expect(remoteBranches(s)).toEqual(["main"]);
    const issue = await readIssue(s.root, s.id);
    expect([issue.state, issue.pr]).toEqual(["in_review", undefined]);
  });

  test("a workflow whose onPrOpened is a hive-only PR Created status lands there", async () => {
    const workflow = [
      "version: 1",
      "statuses:",
      ...["backlog", "todo", "in_progress"].map((c) => `  - { id: ${c}, name: ${c}, category: ${c} }`),
      "  - { id: code-review, name: Code Review, category: in_review }",
      "  - { id: hive:pr-created, name: PR Created, category: in_review, jira: { follow: code-review } }",
      "  - { id: done, name: Done, category: done }",
      "  - { id: cancelled, name: Cancelled, category: cancelled }",
      "local: { onPrOpened: hive:pr-created }",
    ].join("\n");
    const s = await setup({ ac: true, workflow });
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, (r.json as { status: string }).status]).toEqual([0, "hive:pr-created"]);
    const issue = await readIssue(s.root, s.id);
    expect([issue.status, issue.state]).toEqual(["hive:pr-created", "in_review"]);
  });

  test("gh not signed in: a refusal that says how to sign in, the issue in review with a note, nothing pushed", async () => {
    const s = await setup({ ac: true });
    fs.writeFileSync(path.join(s.shim, "auth-fail"), "");
    const r = run(s, ["ctl", "complete", s.id, "--json"]);
    expect([r.code, err(r).code, err(r).fix]).toEqual([6, "FORBIDDEN", "gh auth login --hostname github.com, then run this again"]);
    expect(remoteBranches(s)).toEqual(["main"]);
    const issue = await readIssue(s.root, s.id);
    expect([issue.state, issue.pr]).toEqual(["in_review", undefined]);
    expect(issue.sections.activity.at(-1)!.message).toContain("PR not opened: gh is not signed in to github.com");
  });
});

describe("hive pr", () => {
  const merged = (num: number, state: string, extra: Record<string, unknown> = {}) => JSON.stringify({ data: { r0: { [`p${num}`]: {
    url: `https://github.com/acme/widgets/pull/${num}`, state, isDraft: false, merged: state === "MERGED", reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...extra,
  } } } });

  test("create from the main checkout, or from outside every repository, finds the issue's worktree by its branch", async () => {
    const s = await setup();
    const r = run(s, ["pr", "create", s.id, "--json"], s.repo);
    expect([r.code, (r.json as { number: number }).number]).toEqual([0, 7]);
    expect(remoteBranches(s).sort()).toEqual(["TT-1-widgets", "main"]);
    expect(run(s, ["workspace", "register", "--json"], s.repo).code).toBe(0);
    const outside = path.join(s.shim, "..");
    const again = run(s, ["pr", "create", s.id, "--json"], outside);
    expect([again.code, (again.json as { number: number }).number]).toEqual([0, 7]);
  });

  test("sync moves a merged PR's issue to done and a closed one's back to in progress; status only reads", async () => {
    const s = await setup({ ac: true });
    expect(run(s, ["ctl", "complete", s.id, "--json"]).code).toBe(0);
    fs.writeFileSync(path.join(s.shim, "pr-view.json"), JSON.stringify({ number: 7, url: "https://github.com/acme/widgets/pull/7", state: "MERGED", isDraft: false, mergedAt: "2026-10-24T10:00:00Z", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }));
    const st = run(s, ["pr", "status", s.id, "--json"], s.repo);
    expect([st.code, (st.json as { pr: { state: string } }).pr.state]).toEqual([0, "merged"]);
    expect((await readIssue(s.root, s.id)).state).toBe("in_review");

    fs.writeFileSync(path.join(s.shim, "graphql.json"), merged(7, "MERGED"));
    // From the worktree, whose own .hivemind holds no issues: the main checkout's are the ones.
    const r = run(s, ["pr", "sync", "--json"], s.wt);
    expect([r.code, r.json]).toEqual([0, { changes: [{ id: s.id, event: "merged", movedTo: "done", pr: expect.objectContaining({ state: "merged", checks: "passing" }) }] }]);
    expect((await readIssue(s.root, s.id)).state).toBe("done");
    expect(run(s, ["pr", "sync", "--json"], s.repo).json).toEqual({ changes: [] });

    await updateIssue(s.root, s.id, { state: "in_review", pr: { repo: "acme/widgets", number: 7, url: "https://github.com/acme/widgets/pull/7", state: "open" } });
    fs.writeFileSync(path.join(s.shim, "graphql.json"), merged(7, "CLOSED"));
    const c = run(s, ["pr", "sync", s.id, "--json"], s.wt);
    expect([c.code, (c.json as { changes: { event: string; movedTo: string }[] }).changes[0]]).toEqual([0, expect.objectContaining({ event: "closed", movedTo: "in_progress" })]);
  });

  test("cleanup after the merge removes the worktree and the local branch; before it, refuses", async () => {
    const s = await setup({ ac: true });
    const early = run(s, ["pr", "cleanup", s.id, "--json"], s.repo);
    expect([early.code, err(early).message]).toEqual([1, expect.stringContaining("only merged work is cleaned up")]);
    await updateIssue(s.root, s.id, { pr: { repo: "acme/widgets", number: 7, url: "https://github.com/acme/widgets/pull/7", state: "merged" } });
    const r = run(s, ["pr", "cleanup", s.id, "--json"], s.repo);
    expect([r.code, r.json]).toEqual([0, { removed: s.wt, branch: "TT-1-widgets" }]);
    expect(fs.existsSync(s.wt)).toBe(false);
    expect(git(s.repo, "branch", "--format=%(refname:short)")).toBe("main");
  });
});

// The person's own setup: `origin` is the upstream they can't push to, `fork` is theirs. The
// remotes carry GitHub URLs (what hive reads to name the repositories); git's url.insteadOf sends
// the pushes to two local bare repositories, so what lands where is checked for real.
describe("a fork", () => {
  const UPSTREAM = "https://github.com/acme/widgets.git";
  const FORK = "https://github.com/krakujs/widgets.git";
  const repoFacts = (s: Setup, name: string, facts: Record<string, unknown>) =>
    fs.writeFileSync(path.join(s.shim, `repo-${name.replace("/", "--")}.json`), JSON.stringify({ nameWithOwner: name, ...facts }));
  async function forked(o: Parameters<typeof setup>[0] = {}, gh = true) {
    const s = await setup({ ac: true, ...o });
    const fork = path.join(s.origin, "..", "fork.git");
    git(path.dirname(fork), "clone", "-q", "--bare", s.origin, fork);
    git(s.repo, "remote", "set-url", "origin", UPSTREAM);
    git(s.repo, "remote", "add", "fork", FORK);
    git(s.repo, "config", `url.${s.origin}.insteadOf`, UPSTREAM);
    git(s.repo, "config", `url.${fork}.insteadOf`, FORK);
    if (gh) {
      repoFacts(s, "acme/widgets", { viewerPermission: "READ", isFork: false, parent: null });
      repoFacts(s, "krakujs/widgets", { viewerPermission: "ADMIN", isFork: true, parent: { name: "widgets", owner: { login: "acme" } } });
    }
    fs.writeFileSync(path.join(s.shim, "pr-url"), "https://github.com/acme/widgets/pull/42\n");
    const branchesOf = (bare: string) => git(bare, "branch", "--format=%(refname:short)").split("\n").sort();
    return { s, upstream: () => branchesOf(s.origin), fork: () => branchesOf(fork) };
  }
  const created = (s: Setup) => ghCalls(s).find((c) => c[0] === "pr" && c[1] === "create");
  const pairAfter = (argv: string[] | undefined, flag: string) => argv?.[argv.indexOf(flag) + 1];

  test("the branch goes to the fork you can push to, the PR opens on the upstream as owner:branch, and sync reads it there", async () => {
    const f = await forked();
    const r = run(f.s, ["ctl", "complete", f.s.id, "--json"]);
    expect([r.code, (r.json as { pr: { repo: string; number: number } }).pr]).toEqual([0, expect.objectContaining({ repo: "acme/widgets", number: 42 })]);
    expect([f.fork(), f.upstream()]).toEqual([["TT-1-widgets", "main"], ["main"]]);
    expect([pairAfter(created(f.s), "--repo"), pairAfter(created(f.s), "--head")]).toEqual(["acme/widgets", "krakujs:TT-1-widgets"]);
    const issue = await readIssue(f.s.root, f.s.id);
    expect(issue.sections.activity.map((a) => a.message)).toContain("pushed TT-1-widgets to fork");

    // The watcher's pass asks the upstream, where the PR is.
    fs.writeFileSync(path.join(f.s.shim, "graphql.json"), JSON.stringify({ data: { r0: { p42: {
      url: "https://github.com/acme/widgets/pull/42", state: "MERGED", isDraft: false, merged: true, reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    } } } }));
    expect(run(f.s, ["pr", "sync", "--json"], f.s.repo).code).toBe(0);
    const query = ghCalls(f.s).filter((c) => c[1] === "graphql").at(-1)!.join(" ");
    expect(query).toContain('repository(owner: "acme", name: "widgets")');
    expect((await readIssue(f.s.root, f.s.id)).state).toBe("done");
  });

  test("an open PR from this fork's branch is reused; one from another fork with the same branch name is not", async () => {
    const f = await forked();
    const row = (n: number, owner: string) => ({ number: n, url: `https://github.com/acme/widgets/pull/${n}`, isDraft: false, headRepositoryOwner: { login: owner } });
    fs.writeFileSync(path.join(f.s.shim, "pr-list.json"), JSON.stringify([row(5, "someone"), row(6, "krakujs")]));
    const r = run(f.s, ["ctl", "complete", f.s.id, "--json"]);
    expect([r.code, (r.json as { pr: { number: number } }).pr.number, created(f.s)]).toEqual([0, 6, undefined]);
    const list = ghCalls(f.s).find((c) => c[1] === "list")!;
    expect([pairAfter(list, "--repo"), pairAfter(list, "--head")]).toEqual(["acme/widgets", "TT-1-widgets"]);

    const g = await forked();
    fs.writeFileSync(path.join(g.s.shim, "pr-list.json"), JSON.stringify([row(5, "someone")]));
    const r2 = run(g.s, ["ctl", "complete", g.s.id, "--json"]);
    expect([r2.code, (r2.json as { pr: { number: number } }).pr.number, !!created(g.s)]).toEqual([0, 42, true]);
  });

  test("pr_push_remote and pr_repo in config.yaml decide over what the remotes and GitHub say", async () => {
    const f = await forked({ config: { pr_push_remote: "fork", pr_repo: "other/widgets" } }, false);
    fs.writeFileSync(path.join(f.s.shim, "pr-url"), "https://github.com/other/widgets/pull/9\n");
    const r = run(f.s, ["ctl", "complete", f.s.id, "--json"]);
    expect([r.code, (r.json as { pr: { repo: string } }).pr.repo]).toEqual([0, "other/widgets"]);
    expect([f.fork(), f.upstream()]).toEqual([["TT-1-widgets", "main"], ["main"]]);
    expect([pairAfter(created(f.s), "--repo"), pairAfter(created(f.s), "--head")]).toEqual(["other/widgets", "krakujs:TT-1-widgets"]);

    const bad = await forked({ config: { pr_push_remote: "nope" } });
    const r2 = run(bad.s, ["ctl", "complete", bad.s.id, "--json"]);
    expect([r2.code, err(r2).message, err(r2).fix]).toEqual([1, expect.stringContaining("nope is not a remote"), expect.stringContaining("fork")]);
  });
});
