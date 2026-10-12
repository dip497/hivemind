/**
 * The workspace API: each method a workspace's host answers, the positional params it takes, and
 * what it answers. Names are dotted, and are also the audit log's verbs for them.
 */
import type { Issue, IssuePatch, IssueState, IssueSummary, LinkType, NewIssue } from "@hivemind/core/types";
import type { LinkResult, TransferResult } from "@hivemind/core/cross-repo";
import type { ReviewComment } from "@hivemind/core/review";
import type { DiffPayload, DiffScope, GitBranchList, GitRevision, GitStatusSnapshot, HandedOff, WorktreeCreateOpts, WorktreeEntry } from "./git.js";
import type { AgentAnswer, AgentChange, Answerer, AgentChanges, AgentEvent, AgentItem, AgentRead, AgentSessions, ConversationEntry, Folders, Links, PipeChange, Places, SpawnChange, StartAgent, Startable, StatusChange, TileOpened } from "./agents.js";
import type { ActivityLevels, ExitInfo, TerminalOpts, Typist } from "./terminals.js";
import type { JoinQuestion, JoinRequests, PersonHere } from "./people.js";
import type { ClientGrant, NewGrant } from "./grants.js";
import type { FrameClose, FrameClosed, FrameOpened, FrameSpec } from "./frames.js";
import type { ViewFile, ViewListing, ViewScreen } from "./views.js";
import type { HostMessage, PluginMessage, SurfaceRect } from "@hivemind/view-sdk/protocol";
import type { Answering, LinkRole, Role } from "@hivemind/workspace-host/access";
import type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "@hivemind/workspace-host/layout";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";
import type { Appearance } from "@hivemind/core/settings-schema";
import type { WidgetPackage } from "@hivemind/core/widget-format";

/** A press on a widget: one of its buttons (its `action`), or its card. */
export type WidgetPress = { action: unknown } | { click: true };

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
  /** A participant's branch, as a git bundle (base64), landed as `handoff/<who>/<branch>`, with a
   *  Diff tile on the board showing it against the branch checked out here (M4). */
  "git.handOff": (repo: string, branch: string, bundle: string) => HandedOff;
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
  /** (0.18) The agents in the workspace at `repo`, as a phone is told of them: name, program,
   *  state, what each waits on and where it runs; and the feed's position. Each change after it
   *  is an `agent.changed` and an `agent.event` numbered on from `seq`. */
  "agent.list": (repo: string) => { seq: number; agents: AgentItem[] };
  /** (0.18) What `repo`'s readers were told after `seq`, or null when the feed no longer keeps all
   *  of it: list again. */
  "agent.since": (repo: string, seq: number) => { seq: number; changes: AgentChange[]; events: AgentEvent[] } | null;
  /** What each widget in `repo` last drew, by its id. Never stored: it is drawn again when its
   *  code next runs. */
  "widget.all": (repo: string) => Record<string, unknown>;
  /** Whether the caller runs `repo`'s widgets: the first of the person's windows to ask does (on
   *  the host's machine, or on another of their devices that has it open), until it lets go
   *  (`widget.release`) or goes; then `widget.runner` asks the others again. */
  "widget.run": (repo: string) => boolean;
  /** The widgets installed where `repo` is hosted: what a window that shows it offers, draws and
   *  runs. Their code only to the person's own devices, which may run it. */
  "widget.packages": (repo: string) => WidgetPackage[];
  /** An image the widget package `widget` draws, as a data URL (null: none), for a client without
   *  the package. */
  "widget.asset": (repo: string, widget: string, name: string) => string | null;
  /** Every link between agents there is. Each change after it is a `link.pipe` or `link.spawn` event. */
  "link.list": () => Links;
  /** Show a terminal: the first to open a session starts it; one that opens it after joins it,
   *  its screen first. `joined`: another client started it. Its output and exit are events. */
  "terminal.open": (opts: TerminalOpts) => { pid: number; joined: boolean };
  /** Answer what the agent in `tile` waits on, the wait that began at `since` (as `agent.list`
   *  says it): only while it still waits on that, and once; the first answer is the one the agent
   *  gets. `answered` false: it waits on that no more, or someone answered first (`by`). */
  "agent.answer": (tile: string, since: number, answer: AgentAnswer) => { answered: boolean; by?: Answerer };
  /** A message for the agent in `tile`, one line: typed in as its next prompt once it is at its
   *  prompt, Enter after it (M5). `sent` false: no agent runs there. */
  "agent.send": (tile: string, text: string) => { sent: boolean };
  /** What may be started in the workspace at `repo` (M5, spec/agents.md "Starting"): the agents
   *  this device starts, with their model and mode choices, and the workspace's frames. */
  "agent.startable": (repo: string) => Startable;
  /** Where an agent may be started in the workspace at `repo` (spec/agents.md 0.8): each machine,
   *  the agents found there, and its projects and recent folders. */
  "agent.places": (repo: string) => Places;
  /** The folders in `folder`, one of the workspace's projects or inside one. */
  "agent.folders": (repo: string, folder: string) => Folders;
  /** Start an agent in the workspace at `repo`, as the person launches one at their desktop. */
  "agent.start": (repo: string, start: StartAgent) => { tile: string };
  /** Interrupt the turn of the agent in `tile` with the keys its manifest says do. `interrupted`
   *  false: it was neither working nor waiting, or has no terminal. */
  "agent.interrupt": (tile: string) => { interrupted: boolean };
  /** End the session of `tile` and take it off its board. `closed` false: no workspace has it. */
  "agent.close": (tile: string) => { closed: boolean };
  /** What the agent in `tile` changed in the folder it runs in, against its last commit. */
  "agent.diff": (tile: string) => AgentChanges;
  /** What the agent in `tile` and the person said to each other, after `cursor` in `session` (none,
   *  or another session than its own now: the last of it), how far into its session file that goes,
   *  and the session; then each `agent.said` as it is written, from the start of each session it
   *  begins since, until the connection goes. `session` is left out for an agent with none. */
  "agent.conversation": (tile: string, cursor?: number, session?: string) => { entries: ConversationEntry[]; cursor: number; session?: string };
  /** (0.23) Name the tile `tile`: one line, what every surface shows and the control plane calls it. */
  "agent.rename": (tile: string, name: string) => { name: string };
  /** (0.23) Type keys into the agent in `tile` by name (`Down`, `Enter`, `Escape`, `C-c`) or as
   *  text, each a moment after the last, as answering a picker on its screen takes. */
  "agent.keys": (tile: string, keys: string[]) => { keys: number };
  /** (0.23) The agent's reply to the turn after the last message it was sent, waiting for it up to
   *  `timeoutMs` (2 minutes when not given). `UNSUPPORTED` for an agent that says no turn end. */
  "agent.read": (tile: string, timeoutMs?: number) => AgentRead;
  /** (0.23) The last `lines` lines (40 when not given) of what it printed, its terminal's escapes
   *  taken out: as much as the host keeps. */
  "agent.output": (tile: string, lines?: number) => { text: string };
  /** (0.23) The sessions `program` keeps in `place` (the workspace's folder or one of its
   *  worktrees), newest first, `limit` of them at most. */
  "agent.sessions": (place: string, program: string, limit?: number) => AgentSessions;
  /** (0.23) Open a tool's tile in the workspace at `repo`: the tool by its id
   *  (`owner/name/tool`), in `frame` if given, at `url` for one that shows a page. */
  "tool.open": (repo: string, tool: { tool: string; frame?: string; url?: string }) => { tile: string };
  /** (0.23) Pipe the replies of the agent in `src` to the one in `dst`, as its next prompts. */
  "link.connect": (src: string, dst: string) => void;
  /** (0.23) Stop piping `src`'s replies to `dst`, or to every agent when none is named. */
  "link.disconnect": (src: string, dst?: string) => void;
  /** (0.23) The machine's own: the person's, and an agent's here (all but `host.join`), never a
   *  peer's; what only this machine's windows and files do.
   *  A view event for the view shown (`name` dotted, `data` JSON), from `view` if given. */
  "view.emit": (name: string, data?: unknown, view?: string) => unknown;
  /** The commands the plugins running in a window offer. */
  "plugin.commands": () => unknown;
  /** Get a plugin running: `tool:owner/name`, `widget:@owner/name` or `view:id`. */
  "plugin.open": (plugin: string, frame?: string) => unknown;
  /** Run one of a plugin's commands, and answer what it answered. */
  "plugin.call": (plugin: string, command: string, args?: unknown, tile?: string) => unknown;
  /** Bring a tile into view and give it the keyboard. */
  "tile.focus": (tile: string) => null;
  /** The installed views, agents, widgets or tools changed on disk: read them again. */
  "views.rescan": () => null;
  "agents.rescan": () => null;
  "widgets.rescan": () => null;
  "tools.rescan": () => null;
  /** `settings.json` changed on disk: read it again. */
  "settings.reload": () => null;
  /** The workspaces this machine holds, with each one's id once it has one. */
  "host.status": () => { workspaces: Array<{ repo: string; workspace: string | null }> };
  /** Join a workspace someone shared, by its link. */
  "host.join": (link: string) => unknown;
  /** The views installed on this device whose manifest says they work on a phone (P8). */
  "view.list": (workspace?: string, screen?: "desktop") => ViewListing[];
  /** One of view `id`'s files, at `path` inside its package, 4 MiB at most, and the policy to serve
   *  it under; `__sdk.js` and `__entry.html` as the app serves them. */
  "view.file": (id: string, path: string, workspace?: string) => ViewFile;
  /** Open view `id` on the workspace at `repo` for this caller, a remote screen (`screen`: its size
   *  and look; none, 0 by 0 with no colours): its host runs here until `view.close`, the caller
   *  goes, or the host ends it (`view.ended`). What the view posts comes as `view.post`, and what
   *  its host says goes back as `view.said`, to this caller alone. `surfaces` (0.15): the screen
   *  places the live surfaces the view asks for itself, and the view is told it does. */
  "view.open": (id: string, repo: string, screen?: ViewScreen, surfaces?: boolean) => { session: string };
  /** Close the caller's view session `session`. `closed` false: it has none of that name. */
  "view.close": (session: string, workspace?: string) => { closed: boolean };
  "people.list": (repo: string) => PersonHere[];
  "people.role": (repo: string, person: string, role: Role) => void;
  "people.remove": (repo: string, person: string) => void;
  /** A join link; `uses` (0.16): how many people a reusable one lets in at most. */
  "people.invite": (repo: string, role: LinkRole, expiresIn: number, reusable?: boolean, uses?: number) => string;
  /** `role` (0.16): let them in at this role in place of the link's. */
  "people.answer": (repo: string, req: number, allow: boolean, role?: LinkRole) => { answered: boolean };
  /** The questions about `repo` waiting on its owner now, and how it lets in someone with a valid
   *  invite. */
  "people.requests": (repo: string) => JoinRequests;
  /** How `repo` lets in someone with a valid invite: asked about first, or at once at its role. */
  "people.answering": (repo: string, rule: Answering) => void;
  /** Open a frame in `repo` for a folder of it, or for a worktree of it on a branch, made when it is
   *  not there; the frame already bound to that folder when there is one (0.20). */
  "frame.open": (repo: string, spec: FrameSpec) => FrameOpened;
  /** Close the frame `frame` of `repo`, with the frames nested in it (0.20). */
  "frame.close": (repo: string, frame: string, opts?: FrameClose) => FrameClosed;
  /** The programs let drive workspaces here (0.20). */
  "grant.list": () => ClientGrant[];
  /** Let a program drive `repos` at `role`: the grant, and its token, which is never shown again. */
  "grant.create": (grant: NewGrant) => { grant: ClientGrant; token: string };
  /** Take a grant back: its connections close. `revoked` false: there was none of that id. */
  "grant.revoke": (id: string) => { revoked: boolean };
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
  /** (0.17) The host's look, as a guest shows its workspaces: nothing on the host's disk. */
  "appearance.get": () => Appearance;
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
  /** The widget `id` in `repo` drew `tree`, where its code runs (the workspace's owner). */
  "widget.draw": (repo: string, id: string, tree: unknown) => void;
  /** The caller stops running `repo`'s widgets. */
  "widget.release": (repo: string) => void;
  /** (0.19) Someone pressed a button of the widget `id` (`action`), or its card (`click`), where its
   *  code does not run: the window that runs it hears it (`widget.pressed`). */
  "widget.press": (repo: string, id: string, press: WidgetPress) => void;
  /** What the view of the caller's session `session` posts to its host (P8). */
  "view.post": (session: string, message: PluginMessage, workspace?: string) => void;
  /** The screen the view of the caller's session `session` is shown on now: its host tells the view
   *  (`resize`, `theme`) what changed (0.14). */
  "view.screen": (session: string, screen: ViewScreen, workspace?: string) => void;
}

/** What a host sends each client it holds a connection to, unasked. */
export interface WorkspaceEvents {
  "status.changed": (change: StatusChange) => void;
  "link.pipe": (change: PipeChange) => void;
  "link.spawn": (change: SpawnChange) => void;
  "tile.opened": (tile: TileOpened) => void;
  /** A terminal's output, to the clients that show it. */
  "terminal.data": (tile: string, data: string) => void;
  /** What was said next in the conversation of the agent in `tile`, to whoever follows it, in its
   *  session `session`. */
  "agent.said": (tile: string, entries: ConversationEntry[], cursor: number, session: string) => void;
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
  /** Files changed in a repo the client watches (at most one event every 300 ms). */
  "file.changed": (repo: string, change: { paths: string[] }) => void;
  /** Another writer changed a workspace's layouts: `part` is `core`, `board` or `view:<id>`. */
  "store.changed": (change: Pick<WorkspaceChange, "repo" | "part">) => void;
  /** Who is in the workspace `repo` now, each as they last said (`presence.set`). */
  "presence.changed": (repo: string, people: Participant[]) => void;
  /** The widget `id` in `repo` drew `tree` (`widget.draw`). */
  "widget.drawn": (repo: string, id: string, tree: unknown) => void;
  /** (0.18) An agent in `repo` as it is now, or its going (`agent.list`). */
  "agent.changed": (repo: string, change: AgentChange) => void;
  /** (0.18) What happened to an agent in `repo`: a turn ended, it waits, it was answered, it came
   *  or went. */
  "agent.event": (repo: string, event: AgentEvent) => void;
  /** Nobody runs `repo`'s widgets now: a window that shows it asks `widget.run`. */
  "widget.runner": (repo: string) => void;
  /** (0.19) To the window that runs `repo`'s widgets: someone pressed the widget `id`. */
  "widget.pressed": (repo: string, id: string, press: WidgetPress) => void;
  /** (0.17) The host's look changed (`appearance.get`). */
  "appearance.changed": (appearance: Appearance) => void;
  /** Someone asks to join `repo`: to its owner's clients, the first answer counting (M3). */
  "people.asked": (repo: string, question: JoinQuestion) => void;
  /** The question `req` about `repo` was answered, or nobody answered it in time. */
  "people.answered": (repo: string, req: number) => void;
  /** What the host of the caller's view session `session` says to the view (P8). */
  "view.said": (session: string, message: HostMessage) => void;
  "view.rects": (session: string, rects: SurfaceRect[]) => void;
  /** The host ended the caller's view session `session`, and why: it disabled the view. */
  "view.ended": (session: string, why: string) => void;
}

export type Method = keyof WorkspaceMethods;
export type Params<M extends Method> = Parameters<WorkspaceMethods[M]>;
export type Result<M extends Method> = ReturnType<WorkspaceMethods[M]>;
export type Notice = keyof WorkspaceNotices;
export type NoticeParams<N extends Notice> = Parameters<WorkspaceNotices[N]>;
export type Event = keyof WorkspaceEvents;
export type EventParams<E extends Event> = Parameters<WorkspaceEvents[E]>;
