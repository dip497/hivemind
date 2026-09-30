/**
 * The workspace API: each method a workspace's host answers, the positional params it takes, and
 * what it answers. Names are dotted, and are also the audit log's verbs for them.
 */
import type { Issue, IssuePatch, IssueState, IssueSummary, LinkType, NewIssue } from "@hivemind/core/types";
import type { LinkResult, TransferResult } from "@hivemind/core/cross-repo";
import type { ReviewComment } from "@hivemind/core/review";
import type { DiffPayload, DiffScope, GitBranchList, GitRevision, GitStatusSnapshot, WorktreeCreateOpts, WorktreeEntry } from "./git.js";
import type { Links, PipeChange, SpawnChange, StatusChange, TileOpened } from "./agents.js";

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
  /** A file's text, `file` relative to the repo. */
  "file.read": (repo: string, file: string) => string;
  "file.write": (repo: string, file: string, contents: string) => void;
  /** `root` is the workspace's `.hivemind` directory. */
  "issue.list": (root: string) => IssueSummary[];
  "issue.read": (root: string, id: string) => Issue;
  "issue.create": (root: string, issue: NewIssue) => Issue;
  "issue.update": (root: string, id: string, patch: IssuePatch) => Issue;
  /** A state change, with a note in the same activity entry. */
  "issue.setState": (root: string, id: string, state: IssueState, note?: string) => Issue;
  "issue.comment": (root: string, id: string, message: string) => Issue;
  "issue.delete": (root: string, id: string) => void;
  /** `other` may be in another workspace of the host's, found by its prefix. */
  "issue.link": (root: string, id: string, other: string, type: LinkType) => LinkResult;
  "issue.unlink": (root: string, id: string, other: string) => { removed: number };
  /** Into the host's workspace with prefix `prefix`. */
  "issue.move": (root: string, id: string, prefix: string, mode: "move" | "copy") => TransferResult;
  /** The repo's review comments, resolved ones included. */
  "review.list": (repo: string) => ReviewComment[];
  /** Replace the repo's review comments. */
  "review.save": (repo: string, comments: ReviewComment[]) => void;
  /** Every agent session's status there is. Each change after it is a `status.changed` event. */
  "status.all": () => Array<{ tileId: string; status: StatusChange["status"] }>;
  /** Every link between agents there is. Each change after it is a `link.pipe` or `link.spawn` event. */
  "link.list": () => Links;
}

/** What a client tells a host and asks no answer to: a host never answers a notice. */
export interface WorkspaceNotices {}

/** What a host sends each client it holds a connection to, unasked. */
export interface WorkspaceEvents {
  "status.changed": (change: StatusChange) => void;
  "link.pipe": (change: PipeChange) => void;
  "link.spawn": (change: SpawnChange) => void;
  "tile.opened": (tile: TileOpened) => void;
}

export type Method = keyof WorkspaceMethods;
export type Params<M extends Method> = Parameters<WorkspaceMethods[M]>;
export type Result<M extends Method> = ReturnType<WorkspaceMethods[M]>;
export type Notice = keyof WorkspaceNotices;
export type NoticeParams<N extends Notice> = Parameters<WorkspaceNotices[N]>;
export type Event = keyof WorkspaceEvents;
export type EventParams<E extends Event> = Parameters<WorkspaceEvents[E]>;
