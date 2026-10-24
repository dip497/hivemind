// Pull requests for issues (design jira-sync §11.3–§11.4), through `gh`: hive stores no GitHub
// token, and a remote tile's issue uses that machine's `gh`, the way `git` runs there.
import type { PrRef } from "./types.js";

export interface CreatePrOptions {
  draft?: boolean;
  /** Default: `pr_base` in config.yaml, else the repo's default branch. */
  base?: string;
  /** The worktree (or checkout) whose branch is pushed. */
  cwd: string;
  /** The agent's completion summary, put in the PR body. */
  summary?: string;
}

/** A change the watcher (or `hive pr sync`) saw for one issue's PR. */
export interface PrChange {
  id: string;
  pr: PrRef;
  event: "merged" | "closed" | "changes-requested" | "checks-failing" | "reopened";
  /** The status the issue moved to (by `workflow.local`), when it moved. */
  movedTo?: string;
}

/** Push the issue's branch and open its PR; write `pr` and `github`, then move the issue to
 *  `local.onPrOpened`. Implemented in P1 (HIVEMI-1.6). */
export async function createPullRequest(_root: string, _id: string, _opts: CreatePrOptions): Promise<PrRef> {
  throw new Error("createPullRequest: not implemented yet (P1)");
}

/** One pass over every issue with an open PR, batched in one `gh api graphql` call. Implemented in P1. */
export async function syncPullRequests(_root: string): Promise<PrChange[]> {
  throw new Error("syncPullRequests: not implemented yet (P1)");
}
