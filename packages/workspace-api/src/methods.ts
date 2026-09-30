/**
 * The workspace API: each method a workspace's host answers, the positional params it takes, and
 * what it answers. Names are dotted, and are also the audit log's verbs for them.
 */
import type { DiffPayload, DiffScope, GitBranchList, GitRevision, GitStatusSnapshot, WorktreeCreateOpts, WorktreeEntry } from "./git.js";

export interface WorkspaceMethods {
  "git.status": (repo: string) => GitStatusSnapshot;
  /** Tracked and untracked paths, as .gitignore leaves them. */
  "git.listFiles": (repo: string) => string[];
  /** Local and remote branches, for picking what a diff compares. */
  "git.listBranches": (repo: string) => GitBranchList;
  "git.diff": (repo: string, scope: DiffScope, file?: string) => DiffPayload;
  "git.fileContents": (repo: string, file: string, rev: GitRevision) => string;
  "git.stage": (repo: string, files: string[]) => void;
  "git.unstage": (repo: string, files: string[]) => void;
  "git.discard": (repo: string, files: string[]) => void;
  "git.commit": (repo: string, message: string, allowEmpty?: boolean) => { sha: string };
  "git.push": (repo: string, setUpstream?: boolean) => void;
  /** The current branch from its upstream, fast-forward only. */
  "git.pull": (repo: string) => void;
  "git.conflictedFile": (repo: string, file: string) => { raw: string; conflicts: number };
  "git.writeResolved": (repo: string, file: string, contents: string) => void;
  "worktree.list": (repo: string) => WorktreeEntry[];
  "worktree.create": (repo: string, opts: WorktreeCreateOpts) => { path: string; branch: string };
  "worktree.remove": (repo: string, worktree: string, force?: boolean) => void;
  "worktree.prune": (repo: string) => { removed: string[] };
}

export type Method = keyof WorkspaceMethods;
export type Params<M extends Method> = Parameters<WorkspaceMethods[M]>;
export type Result<M extends Method> = ReturnType<WorkspaceMethods[M]>;
