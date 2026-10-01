/**
 * The workspace API: each method a workspace's host answers, the positional params it takes, and
 * what it answers. Names are dotted, and are also the audit log's verbs for them.
 */
import type { Issue, IssuePatch, IssueState, IssueSummary, LinkType, NewIssue } from "@hivemind/core/types";
import type { LinkResult, TransferResult } from "@hivemind/core/cross-repo";
import type { ReviewComment } from "@hivemind/core/review";
import type { DiffPayload, DiffScope, GitBranchList, GitRevision, GitStatusSnapshot, WorktreeCreateOpts, WorktreeEntry } from "./git.js";
import type { Links, PipeChange, SpawnChange, StatusChange, TileOpened } from "./agents.js";
import type { ActivityLevels, ExitInfo, TerminalOpts, Typist } from "./terminals.js";
import type { Answerer, PlanDecided, PlanReview } from "./plans.js";
import type { JoinQuestion, PersonHere } from "./people.js";
import type { LinkRole, Role } from "@hivemind/workspace-host/access";
import type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "@hivemind/workspace-host/layout";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";

/** A workspace's layouts as a client that holds them opens it. */
export interface StoreSnapshot {
  core: CoreLayout | null;
  views: Record<string, ViewLayout>;
  objects: BoardObject[];
}

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
  /** Show a terminal: the first to open a session starts it; one that opens it after joins it,
   *  its screen first. `joined`: another client started it. Its output and exit are events. */
  "terminal.open": (opts: TerminalOpts) => { pid: number; joined: boolean };
  /** The plans the agents of `repo` are waiting on a person for (M2). Each after it is a
   *  `plan.review` event, and each answer a `plan.decided`. */
  "plan.list": (repo: string) => PlanReview[];
  /** Answer the plan `requestId` the agent in `tile` handed off: the first answer is the one the
   *  agent gets. `answered` false: someone answered first (`by`), or it is no longer waited on. */
  "plan.decide": (tile: string, requestId: string, decision: "allow" | "deny", feedback?: string) => { answered: boolean; by: Answerer | null };
  "people.list": (repo: string) => PersonHere[];
  "people.role": (repo: string, person: string, role: Role) => void;
  "people.remove": (repo: string, person: string) => void;
  "people.invite": (repo: string, role: LinkRole, expiresIn: number, reusable?: boolean) => string;
  "people.answer": (repo: string, req: number, allow: boolean) => { answered: boolean };
  /** A workspace's layouts, for a client that holds them: every read after it answers from what
   *  it holds, and each `store.changed` says what to read again. */
  "store.open": (repo: string) => StoreSnapshot;
  "store.core": (repo: string) => CoreLayout | null;
  "store.view": (repo: string, viewId: string) => ViewLayout | null;
  "store.objects": (repo: string) => BoardObject[];
  /** Each write names the layout it was made from (`base`; null: none was read), so only what
   *  the client changed is written and another writer's change is kept. */
  "store.setCore": (repo: string, core: unknown, base?: unknown) => void;
  "store.setView": (repo: string, viewId: string, layout: ViewLayout, base?: ViewLayout | null) => void;
  "store.setObjects": (repo: string, objects: BoardObject[], base?: BoardObject[] | null) => void;
  /** What a client kept before the store: the store keeps only what it lacks. */
  "store.import": (repo: string, legacy: LegacyLayout) => void;
  /** Take back the client's last board edit, or make it again: whether there was one. */
  "store.undo": (repo: string) => boolean;
  "store.redo": (repo: string) => boolean;
}

/** What a client tells a host and asks no answer to: a host never answers a notice. */
export interface WorkspaceNotices {
  /** Keystrokes; `paste`: one block handed to the program, not keys. */
  "terminal.write": (tile: string, data: string, paste?: boolean) => void;
  /** Whether any of the client's views shows the terminal: it is sent its output only while one
   *  does, and its screen when one shows it again. */
  "terminal.show": (tile: string, shown: boolean) => void;
  /** While several clients show a session, only the one that typed last sizes it. */
  "terminal.resize": (tile: string, cols: number, rows: number) => void;
  /** Stop reading the session's output while the client catches up; a pause lasts a moment
   *  unless it is asked for again. */
  "terminal.flow": (tile: string, paused: boolean) => void;
  /** End the session for good. */
  "terminal.close": (tile: string) => void;
  /** The client shows the terminal no more; a session nobody shows is let go of (a daemon keeps
   *  it running). */
  "terminal.detach": (tile: string) => void;
  /** The terminals whose activity the client wants (`terminal.activity`). */
  "terminal.watchActivity": (tiles: string[]) => void;
  /** Ask for the terminal's keyboard: whoever holds it is asked (M2). */
  "terminal.keyboard.ask": (tile: string) => void;
  /** Give the terminal's keyboard, which the client holds (or the host does), to `to`, who asked. */
  "terminal.keyboard.give": (tile: string, to: string) => void;
  /** Take the terminal's keyboard back: the host's. */
  "terminal.keyboard.take": (tile: string) => void;
  /** The workspace the client shows now (null: none), and the frame its user is in there. */
  "store.shown": (repo: string | null, frame: string | null) => void;
  /** Where the client's person is in the workspace `repo`: their pointer and selection; null:
   *  they left it. */
  "presence.set": (repo: string, state: PresenceState | null) => void;
}

/** What a host sends each client it holds a connection to, unasked. */
export interface WorkspaceEvents {
  "status.changed": (change: StatusChange) => void;
  "link.pipe": (change: PipeChange) => void;
  "link.spawn": (change: SpawnChange) => void;
  "tile.opened": (tile: TileOpened) => void;
  /** A terminal's output, to the clients that show it. */
  "terminal.data": (tile: string, data: string) => void;
  /** A terminal's session ended, to the clients that showed it. */
  "terminal.exit": (tile: string, info: ExitInfo) => void;
  /** Changes in watched terminals' activity. */
  "terminal.activity": (levels: ActivityLevels) => void;
  /** Who holds a terminal's keyboard now: null while the host does. */
  "terminal.keyboard": (tile: string, holder: Typist | null) => void;
  /** Someone asks for the keyboard the client holds (or the host's windows, while the host does). */
  "terminal.keyboard.asked": (tile: string, asker: Typist) => void;
  /** A terminal's size changed: a client whose own differs draws it at this size. */
  "terminal.size": (tile: string, cols: number, rows: number) => void;
  /** Someone types into `tile`: to each client that opened it but theirs, at most once a second
   *  for the same person typing (R4). */
  "terminal.typing": (tile: string, by: Typist) => void;
  /** An agent handed off a plan for review (M2). */
  "plan.review": (review: PlanReview) => void;
  /** A plan was answered, and by whom; or its agent stopped waiting (`decision` null). */
  "plan.decided": (decided: PlanDecided) => void;
  /** Files changed in a repo the client watches (at most one event every 300 ms). */
  "file.changed": (repo: string, change: { paths: string[] }) => void;
  /** Another writer changed a workspace's layouts: `part` is `core`, `board` or `view:<id>`. */
  "store.changed": (change: Pick<WorkspaceChange, "repo" | "part">) => void;
  /** Who is in the workspace `repo` now, each as they last said (`presence.set`). */
  "presence.changed": (repo: string, people: Participant[]) => void;
  /** Someone asks to join `repo`: to its owner's clients, the first answer counting (M3). */
  "people.asked": (repo: string, question: JoinQuestion) => void;
  /** The question `req` about `repo` was answered, or nobody answered it in time. */
  "people.answered": (repo: string, req: number) => void;
}

export type Method = keyof WorkspaceMethods;
export type Params<M extends Method> = Parameters<WorkspaceMethods[M]>;
export type Result<M extends Method> = ReturnType<WorkspaceMethods[M]>;
export type Notice = keyof WorkspaceNotices;
export type NoticeParams<N extends Notice> = Parameters<WorkspaceNotices[N]>;
export type Event = keyof WorkspaceEvents;
export type EventParams<E extends Event> = Parameters<WorkspaceEvents[E]>;
