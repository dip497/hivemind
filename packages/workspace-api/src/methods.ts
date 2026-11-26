/**
 * The workspace API: each method a workspace's host answers, the positional params it takes, and
 * what it answers. Names are dotted, and are also the audit log's verbs for them.
 */
import type { Issue, IssuePatch, IssueState, IssueSummary, LinkType, NewIssue } from "@hivemind/core/types";
import type { LinkResult, TransferResult } from "@hivemind/core/cross-repo";
import type { CodeAnchor, CodeComment, PageBox, PageComment, ReviewComment, ReviewIntent } from "@hivemind/core/review";
import type { BoardAsk, BoardChange, BoardChangeAsk, BoardChanged, BoardChanges, BoardComment, BoardDrawAsk, BoardDrawn, BoardEraseAsk, BoardNoteAsked, BoardPicture, BoardPictureAsk, BoardReading, BoardSelection } from "./board.js";
import type { PageListing, PageNewAsk } from "./pages.js";
import type { FindFilesPage, GrepMode, GrepPage } from "./code.js";
import type { Answer as CodeAnswer, Place as CodePlace } from "@hivemind/code-intel/contract";
import type { FileStat, OpenedThing } from "./opener.js";
import type { BlameOptions, BlamePayload, CommitInfo, DiffPayload, DiffScope, FileHistoryCursor, FileHistoryPage, GitBranchList, GitRevision, GitStatusSnapshot, HandedOff, LogOptions, LogPage, WorktreeCreateOpts, WorktreeEntry } from "./git.js";
import type { SleepAnswer, WakeAnswer } from "./agents.js";
import type { AgentAnswer, AgentChange, Approval, Answerer, AgentChanges, AgentEvent, AgentItem, AgentRead, AgentSessions, ConversationEntry, SentFile, SentFilePiece, SlashCommand, Folders, Links, PipeChange, Places, SpawnChange, StartAgent, StartImage, Startable, StatusChange, TileOpened, ToolUse } from "./agents.js";
import type { ActivityLevels, ExitInfo, LastLines, TerminalOpts, Typist } from "./terminals.js";
import type { JoinQuestion, JoinRequests, PersonHere } from "./people.js";
import type { GuestAnswer } from "@hivemind/workspace-host/connect";
import type { DeviceCertificate } from "@hivemind/workspace-host/identity";
import type { ClientGrant, NewGrant } from "./grants.js";
import type { FrameClose, FrameClosed, FrameOpened, FrameSpec } from "./frames.js";
import type { ViewFile, ViewListing, ViewScreen } from "./views.js";
import type { PluginList, TileLook } from "./plugins.js";
import type { HostMessage, PluginMessage, SurfaceRect } from "@hivemind/view-sdk/protocol";
import type { Answering, LinkRole, Role } from "@hivemind/workspace-host/access";
import type { BoardEdit, BoardImage, BoardImageType, BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "@hivemind/workspace-host/layout";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";
import type { SharedAppearance } from "@hivemind/core/settings-schema";
import type { WallpaperMediaPiece } from "./home.js";
import type { WidgetPackage } from "@hivemind/core/widget-format";
import type { RecentSound, SoundMoment, SoundResult } from "./notifications.js";

/** A note asked for on a page: on the one element a selector finds, or on an area of the page. */
export type PageNoteAsked = { body: string; intent?: ReviewIntent } & ({ selector: string; area?: undefined } | { area: PageBox; selector?: undefined });

/** A press on a widget: one of its buttons (its `action`), or its card. */
export type WidgetPress = { action: unknown } | { click: true };

/** A workspace's layouts as a client that holds them opens it. */
export interface StoreSnapshot {
  core: CoreLayout | null;
  views: Record<string, ViewLayout>;
  objects: BoardObject[];
}

/** A question an agent has put to the person on a Browser tile. */
export type BrowserPersonAsk = { ask: number; tile: string; by: string | null } & (
  | { kind: "hand-over"; words: string }
  | { kind: "sign-in"; name: string; site: string; username: string }
);
/** Where such a question stands. `person`: it needs the person, and `why` says what shows. */
export type BrowserAskState =
  | { state: "waiting" | "working" }
  | { state: "done"; outcome: "done" | "no" | "expired" | "sent" | "person"; url?: string; why?: string };

export interface WorkspaceMethods {
  "git.status": (repo: string) => GitStatusSnapshot;
  /** Tracked and untracked paths, as .gitignore leaves them. */
  "git.listFiles": (repo: string) => string[];
  /** Local and remote branches, for picking what a diff compares. */
  "git.listBranches": (repo: string) => GitBranchList;
  "git.diff": (repo: string, scope: DiffScope, file?: string) => DiffPayload;
  "git.fileContents": (repo: string, file: string, rev: GitRevision) => string;
  /** (0.39) The log, a page at a time: the current branch in git's order, or every branch by date. */
  "git.log": (repo: string, opts?: LogOptions) => LogPage;
  /** (0.39) A file's commits, newest first, through its renames. */
  "git.fileHistory": (repo: string, file: string, cursor?: FileHistoryCursor) => FileHistoryPage;
  /** (0.39) Who last changed each line, as runs of lines; of the editor's text when given. */
  "git.blame": (repo: string, file: string, opts?: BlameOptions) => BlamePayload;
  /** (0.39) A commit's message and the files it changed against its first parent. */
  "git.commitInfo": (repo: string, sha: string) => CommitInfo;
  "git.stage": (repo: string, files: string[]) => void;
  "git.unstage": (repo: string, files: string[]) => void;
  "git.discard": (repo: string, files: string[]) => void;
  "git.commit": (repo: string, message: string, allowEmpty?: boolean) => { sha: string };
  "git.push": (repo: string, setUpstream?: boolean) => void;
  /** The current branch from its upstream, fast-forward only. */
  "git.pull": (repo: string) => void;
  "git.conflictedFile": (repo: string, file: string) => { raw: string; conflicts: number };
  "git.writeResolved": (repo: string, file: string, contents: string) => void;
  /** (0.40) Files by a fuzzy name: what the person opens often and lately first. */
  "code.findFiles": (repo: string, query: string, limit?: number) => FindFilesPage;
  /** (0.40) The person picked `file` for `query`: ranked higher for it next time. */
  "code.picked": (repo: string, query: string, file: string) => void;
  /** (0.40) Lines by their text, a page at a time. */
  "code.grep": (repo: string, query: string, opts?: { mode?: GrepMode; cursor?: number; caseSensitive?: boolean }) => GrepPage;
  /** (0.43) A file's outline from its syntax. `opts.text` asks about the editor's unsaved text;
   *  `opts.version` is the caller's own count, given back in the answer. */
  "code.outline": (repo: string, file: string, opts?: CodeAsk) => CodeAnswer<"documentSymbol"> | null;
  /** (0.43) Where the symbol at `at` is defined: the language server's answer, else the file's outline. */
  "code.definition": (repo: string, file: string, at: CodePlace, opts?: CodeAsk) => CodeAnswer<"definition"> | null;
  /** (0.43) Every usage of the symbol at `at`: the language server's, else a search for the word. */
  "code.usages": (repo: string, file: string, at: CodePlace, opts?: CodeAsk) => CodeAnswer<"references"> | null;
  /** (0.43) What the language server says of the symbol at `at`, as markdown. */
  "code.hover": (repo: string, file: string, at: CodePlace, opts?: CodeAsk) => CodeAnswer<"hover"> | null;
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
  /** (0.43) A file or a folder and its size, null when nothing is there; on this computer only. */
  "file.stat": (repo: string, file: string) => FileStat | null;
  /** (0.43) A file's bytes as base64, at most `FILE_BYTES_MAX`: a picture the Image tile shows. */
  "file.bytes": (repo: string, file: string) => { base64: string; size: number };
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
  /** Replace the repo's comments on a diff; its notes on pages are kept. */
  "review.save": (repo: string, comments: ReviewComment[]) => void;
  /** (0.43) A comment on lines of a file, by the person. */
  "review.add": (repo: string, comment: Omit<CodeComment, "id" | "at" | "author">) => CodeComment;
  /** (0.43) A comment on code moved to where its lines are now, with what they say now. */
  "review.move": (repo: string, id: string, to: CodeAnchor) => ReviewComment;
  /** One comment, changed by what it is: each refuses a comment not where the change starts from
   *  (core's review rules). */
  "review.seen": (repo: string, id: string) => ReviewComment;
  "review.resolve": (repo: string, id: string, summary?: string) => ReviewComment;
  "review.dismiss": (repo: string, id: string, reason: string) => ReviewComment;
  "review.reopen": (repo: string, id: string) => ReviewComment;
  "review.reply": (repo: string, id: string, body: string) => ReviewComment;
  "review.edit": (repo: string, id: string, body: string) => ReviewComment;
  "review.delete": (repo: string, id: string) => void;
  /** These notes on a page as one message to an agent, with how to answer them; null when none is
   *  there. */
  "review.message": (repo: string, ids: string[]) => string | null;
  /** Every agent session's status there is. Each change after it is a `status.changed` event. */
  "status.all": () => Array<{ tileId: string; status: StatusChange["status"] }>;
  /** (0.34) Watch the last lines of `tiles` (at most 1024), in place of those the caller watched (none:
   *  it watches none). What each one's screen last showed with text, for those that showed one;
   *  each change after it is a `tile.lines` to the caller alone. */
  "tile.watchLines": (tiles: string[]) => { lines: LastLines };
  /** (0.35) The last lines of `tiles` (at most 1024) now, once, for those that showed one: for an
   *  agent that keeps a conversation, what it last said, read first when it is being read or never
   *  was. Watches nothing. */
  "tile.readLines": (tiles: string[]) => { lines: LastLines };
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
  "terminal.open": (opts: TerminalOpts) => { pid: number; joined: boolean; asleep?: true };
  /** What the agent in `tile`, put to sleep, last showed, with its newest 1000 lines when `lines`
   *  asks for no more (none: all it saved); null when it does not sleep. `asleep` in
   *  `terminal.open`'s answer: it sleeps, and nothing was started. */
  "terminal.saved": (tile: string, lines?: number) => string | null;
  /** Answer what the agent in `tile` waits on, the wait that began at `since` (as `agent.list`
   *  says it): only while it still waits on that, and once; the first answer is the one the agent
   *  gets. `answered` false: it waits on that no more, or someone answered first (`by`). */
  "agent.answer": (tile: string, since: number, answer: AgentAnswer) => { answered: boolean; by?: Answerer };
  /** A message for the agent in `tile`, one line: typed in as its next prompt once it is at its
   *  prompt, Enter after it (M5). `sent` false: no agent runs there. */
  /** `held` (0.33): it waits for the agent's turn to end; `photos` (0.33): where the photos given
   *  with it were kept. */
  "agent.send": (tile: string, text: string, given?: { images?: StartImage[] }) => { sent: boolean; held?: true; photos?: string[] };
  /** A photo pasted into a terminal, kept on the machine its session runs on (0.37): its path, for
   *  the client to type. */
  "terminal.photo": (tile: string, image: StartImage) => { path: string };
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
  /** Put to sleep the agents of `target` in the workspace of `repo` (a tile or a frame, by id or
   *  name; none: all of them): each one's process ends, its last screen and its conversation wait
   *  for `agent.wake`. One working or waiting on someone is left, unless `force`. */
  "agent.sleep": (repo: string, target?: string, force?: boolean) => SleepAnswer;
  /** Wake the sleeping agents of `target` in the workspace of `repo` (none: all of them): each
   *  starts again in its conversation. */
  "agent.wake": (repo: string, target?: string) => WakeAnswer;
  /** What the agent in `tile` changed in the folder it runs in, against its last commit. */
  "agent.diff": (tile: string) => AgentChanges;
  /** What the agent in `tile` and the person said to each other, after `cursor` in `session` (none,
   *  or another session than its own now: the last of it), how far into its session file that goes,
   *  and the session; then each `agent.said` as it is written, from the start of each session it
   *  begins since, until the connection goes. `session` is left out for an agent with none. */
  /** (0.39) What was said just before byte `before` of its session `session`: where `agent.conversation`
   *  or this last answered it begins. `before` 0: nothing earlier. */
  "agent.conversationBefore": (tile: string, session: string, before: number) => { entries: ConversationEntry[]; before: number };
  "agent.conversation": (tile: string, cursor?: number, session?: string) => { entries: ConversationEntry[]; cursor: number; session?: string };
  /** (0.9 of spec/agents.md) The tool use `use` in the conversation of the agent of `tile`, unfolded. */
  "agent.tool": (tile: string, use: string) => ToolUse;
  /** (0.32) The session the agent in `tile` is in, and its file on this machine. */
  "agent.transcript": (tile: string) => { session: string; path: string };
  /** (0.31) The supervised tool use the agent in `tile` waits on, its input whole. */
  "agent.approval": (tile: string) => Approval;
  /** (0.23) Name the tile `tile`: one line, what every surface shows and the control plane calls it. */
  "agent.rename": (tile: string, name: string) => { name: string };
  /** (0.23) Type keys into the agent in `tile` by name (`Down`, `Enter`, `Escape`, `C-c`) or as
   *  text, each a moment after the last, as answering a picker on its screen takes. */
  "agent.keys": (tile: string, keys: string[]) => { keys: number };
  /** (0.23) The agent's reply to the turn after the last message it was sent, waiting for it up to
   *  `timeoutMs` (2 minutes when not given). `UNSUPPORTED` for an agent that says no turn end;
   *  `NO_AGENT` for a tile that runs none (0.33). */
  "agent.read": (tile: string, timeoutMs?: number) => AgentRead;
  /** (0.23) The last `lines` lines (40 when not given) of what it printed, its terminal's escapes
   *  taken out: as much as the host keeps. */
  "agent.output": (tile: string, lines?: number) => { text: string };
  /** (0.23) The sessions `program` keeps in `place` (the workspace's folder or one of its
   *  worktrees), newest first, `limit` of them at most. */
  "agent.sessions": (place: string, program: string, limit?: number) => AgentSessions;
  /** (0.36) The slash commands the agent of `tile` takes at its prompt: its own, the person's and
   *  the project's, as its manifest says where they are; by name. */
  "agent.commands": (tile: string) => { commands: SlashCommand[] };
  /** (0.39) Freeze the file at `path` on this computer for the person's phone, as the agent of
   *  `tile`: what was kept. A program here alone, and an agent only as itself. */
  "agent.sendFile": (tile: string, path: string) => SentFile;
  /** (0.39) What the agent of `tile` sent and is still kept, oldest first: a program here alone. */
  "agent.sentFiles": (tile: string) => { files: SentFile[] };
  /** (0.39) The owner's alone: the files the agent of `tile` sent, oldest first; the caller is sent
   *  `agent.filesChanged` from now until it goes. */
  "agent.files": (tile: string) => { files: SentFile[] };
  /** (0.39) The owner's alone: a piece of a file an agent sent, from `offset`. */
  "agent.filePiece": (id: string, offset: number) => SentFilePiece;
  /** (0.39) Remove a file an agent sent, before the phone fetches it or after: a program here alone,
   *  and an agent only its own. */
  "agent.takeBackFile": (id: string) => { takenBack: boolean };
  /** (0.23) Open a tool's tile in the workspace at `repo`: the tool by its id
   *  (`@owner/name/tool`, or `@owner/name` when the package has one tool), in `frame` if given, at
   *  `url` for one that shows a page, with `state` (0.32) as the tile's first saved state. */
  /** What an agent asks of the person on a Browser tile, and their answer (0.38). */
  "browser.signIns": () => { signIns: { name: string; site: string }[] };
  "browser.ask": (words: string, tile?: string) => { ask: number; tile: string };
  "browser.signIn": (name: string, tile?: string) => { ask: number; tile: string };
  "browser.askState": (ask: number, ms?: number) => BrowserAskState;
  "browser.asks": () => { asks: BrowserPersonAsk[] };
  "browser.answer": (ask: number, answer: "yes" | "always" | "no" | "done") => { answered: boolean };
  "tool.open": (repo: string, tool: { tool: string; frame?: string; url?: string; state?: Record<string, unknown> }) => { tile: string };
  /** (0.23) Pipe the replies of the agent in `src` to the one in `dst`, as its next prompts. */
  "link.connect": (src: string, dst: string) => void;
  /** (0.23) Stop piping `src`'s replies to `dst`, or to every agent when none is named. */
  "link.disconnect": (src: string, dst?: string) => void;
  /** (0.23) The machine's own: the person's, and an agent's here (all but `host.join`), never a
   *  peer's; what only this machine's windows and files do.
   *  A view event for the view shown (`name` dotted, `data` JSON), from `view` if given. */
  "view.emit": (name: string, data?: unknown, view?: string) => unknown;
  /** (0.27) Every plugin running in a window, each with its state (starting, ready, failed), the
   *  views it can show, and (0.37) every widget in the workspace with the view it floats over alone
   *  (`plugins.ts`). */
  "plugin.list": () => PluginList;
  /** The commands the ready plugins running in a window offer. */
  "plugin.commands": () => unknown;
  /** Get a plugin running: `tool:owner/name`, `widget:@owner/name` or `view:id`; answered once it
   *  can be called, or with the state it reached (0.27). (0.37) A widget's id (`plugin.list`) shows
   *  that widget over every view. */
  "plugin.open": (plugin: string, frame?: string) => unknown;
  /** Run one of a plugin's commands, and answer what it answered; one still starting is waited for (0.27). */
  "plugin.call": (plugin: string, command: string, args?: unknown, tile?: string) => unknown;
  /** (0.27) Stop the running plugin `instance` (as `plugin.list` names it): a tool's tile closed, a
   *  widget taken off the board, a view left for the canvas. */
  "plugin.close": (instance: string, plugin?: string) => { closed: string; plugin: string; kind: string };
  /** Bring a tile into view and give it the keyboard. */
  /** (0.42) Draw on the board: boxes and links placed for the caller, or shapes it places itself. */
  "board.draw": (repo: string, asked: BoardDrawAsk, as?: BoardWriter) => BoardDrawn;
  /** (0.42) What is on the board, in canvas coordinates: an overview, or those asked for in full. */
  "board.read": (repo: string, ask?: BoardAsk) => BoardReading;
  /** (0.43) What each window showing `repo`, or another device, has selected now. */
  "board.selected": (repo: string) => BoardSelection;
  /** (0.43) The board's changes after `since`, and who made each; left out, where the feed is now.
   *  `follow`: each change after it is a `board.changed` to the caller, until it goes. */
  "board.changes": (repo: string, since?: number | null, follow?: boolean) => BoardChanges;
  /** (0.42) What is drawn, as a picture: an SVG, or with `png` a PNG, which needs a window. */
  "board.picture": (repo: string, ask?: BoardPictureAsk) => BoardPicture;
  /** (0.43) Keep a picture for the board: a PNG, JPEG, WebP or GIF of at most 10 MB, made no larger
   *  than 4096 pixels on its long side by a window (refused where none can). What a draw's box
   *  names by `image`, and an `image` shape shows. */
  "board.keepImage": (repo: string, image: StartImage) => BoardImage;
  /** (0.43) A picture kept for the board, by its hash, in base64: as anyone who may read the board may. */
  "board.image": (repo: string, hash: string) => { type: BoardImageType; data: string };
  /** (0.42) Erase shapes and arrows: by id, by drawing, or what one agent drew. */
  "board.erase": (repo: string, ask: BoardEraseAsk, as?: BoardWriter) => { erased: string[] };
  /** Move, restyle, lock, restack, line up, copy or move into a page shapes and arrows already drawn. */
  "board.change": (repo: string, ask: BoardChangeAsk, as?: BoardWriter) => BoardChanged;
  /** (0.43) Take back the caller's own last board change, or make it again: kept for an hour unused. */
  "board.undo": (repo: string, as?: BoardWriter) => { undone: boolean };
  "board.redo": (repo: string, as?: BoardWriter) => { redone: boolean };
  /** (0.42) Pin a note on the board, or on something there; `hive ctl notes` answers it. */
  "board.note": (repo: string, note: BoardNoteAsked) => BoardComment;
  /** (0.42) Bring a drawing, or something on the board, into view. */
  "board.show": (repo: string, target: string) => null;
  /** (0.43) The pages of a workspace: frames marked as stops on a window's path. */
  "page.list": (repo: string) => { pages: PageListing[] };
  /** Make a page, inside a page or frame or on the canvas itself. */
  "page.new": (repo: string, ask: PageNewAsk) => { id: string };
  /** A window flies to a page or frame and goes inside it (null: out to the whole canvas). */
  "page.open": (repo: string, id: string | null) => null;
  "tile.focus": (tile: string) => null;
  /** (0.43) Open a URL or a file (`path:line:col`, absolute) in the window, where the person's link
   *  settings say, as a click in `tile`'s frame: an agent's own tile when an agent asks. Refused
   *  `UNSUPPORTED` when it would ask the person, `NOT_FOUND` when the file is not there. */
  "opener.open": (thing: string, tile?: string) => OpenedThing;
  /** (0.32) Bring a tile into view, wait for its plugin to draw, and answer a picture of it with its
   *  plugin's state and the last lines its code wrote (`plugins.ts`). */
  "tile.look": (tile: string) => TileLook;
  /** (0.38) A note on the page in a Browser tile, as a person's holds, by whoever asks. `tile` is the
   *  Browser tile, or an agent's beside the one Browser tile in its frame. `kept`: the folder the
   *  review is in. */
  "page.note": (tile: string, note: PageNoteAsked) => { note: PageComment; kept: string };
  /** The installed views, agents, widgets or tools changed on disk: read them again. */
  "views.rescan": () => null;
  "agents.rescan": () => null;
  "widgets.rescan": () => null;
  "tools.rescan": () => null;
  /** `settings.json` changed on disk: read it again. */
  "settings.reload": () => null;
  /** (0.35) Play `moment`'s sound now in the window the person is at, and answer what became of it.
   *  The person's alone: refused to an agent's tile. The app answers it; `hive host` does not. */
  "notifications.play": (moment: SoundMoment) => SoundResult;
  /** (0.35) The last 10 bursts of agents' changes and what each sounded and showed, newest first. */
  "notifications.recentSounds": () => RecentSound[];
  /** The workspaces this machine holds, with each one's id once it has one. */
  "host.status": () => { workspaces: Array<{ repo: string; workspace: string | null }> };
  /** Join a workspace someone shared, by its link. */
  "host.join": (link: string) => unknown;
  /** (0.30) Serve the folder `folder` on this machine as one of its workspaces, with no window
   *  opened for it; one it serves already is answered as it is. */
  "host.add": (folder: string) => { repo: string; workspace: string };
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
  /** Let in the device whose certificate asked the owner's app to connect, answered someone else
   *  (0.25): where it finds the workspace. */
  "people.admit": (repo: string, certificate: DeviceCertificate, profile: { name: string; color: string }, role: LinkRole) => GuestAnswer;
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
  /** (0.28) The board's objects with these ids, by id (null: not there): what a client reads when
   *  `store.changed` names the objects that changed. */
  "store.objectsWithIds": (repo: string, ids: string[]) => Record<string, BoardObject | null>;
  /** Each write names the layout it was made from (`base`; null: none was read), so only what
   *  the client changed is written and another writer's change is kept. A board edit (0.28) holds
   *  only the objects the client changed, each with the one it changed it from. */
  "store.setCore": (repo: string, core: unknown, base?: unknown) => void;
  "store.setView": (repo: string, viewId: string, layout: ViewLayout, base?: ViewLayout | null) => void;
  "store.editObjects": (repo: string, edit: BoardEdit) => void;
  /** What a client kept before the store: the store keeps only what it lacks. */
  "store.import": (repo: string, legacy: LegacyLayout) => void;
  /** Take back the client's last board edit, or make it again: whether there was one. */
  "store.undo": (repo: string) => boolean;
  "store.redo": (repo: string) => boolean;
  /** (0.17) The host's look, as a guest shows its workspaces: nothing on the host's disk. (0.35)
   *  With its custom accent's colours (`accentCustom`), which win over `accent` while set. */
  "appearance.get": () => SharedAppearance;
  /** (0.38) The owner's alone: a piece of the wallpaper's photo or video, from `offset`, while its
   *  revision (Home's `look.wallpaper.media`) is `revision`. */
  "appearance.media": (revision: string, offset: number) => WallpaperMediaPiece;
  /** (0.38) The owner's alone: the file `path` of the live wallpaper drawn now, as `view.file`. */
  "appearance.wallpaperFile": (path: string) => ViewFile;
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
  /** A client that opened it with `acks` has taken `taken` of its output, in UTF-16 units, all
   *  told: it is sent no more than a window ahead of that. */
  "terminal.ack": (tile: string, taken: number) => void;
  /** Size it to the client's screen until the client goes; no size: back to the one it had. */
  "terminal.fit": (tile: string, cols?: number, rows?: number) => void;
  /** Send the client the screen again, with at most `lines` of its scrollback from now on. */
  "terminal.history": (tile: string, lines: number) => void;
  /** End the session for good. */
  "terminal.close": (tile: string) => void;
  /** The client shows the terminal no more; a session nobody shows is let go of (a daemon keeps
   *  it running). */
  "terminal.detach": (tile: string) => void;
  /** The terminals whose activity the client wants (`terminal.activity`). */
  "terminal.watchActivity": (tiles: string[]) => void;
  /** (0.43) Take back the code question the caller asked with this `ask` id: it is answered null. */
  "code.cancel": (ask: number) => void;
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
  /** (0.39) The files the agent of `tile` sent, whole, to whoever asked `agent.files`, when they change. */
  "agent.filesChanged": (tile: string, files: SentFile[]) => void;
  /** A terminal's session ended, to the clients that showed it. */
  "terminal.exit": (tile: string, info: ExitInfo) => void;
  /** Changes in watched terminals' activity. */
  "terminal.activity": (levels: ActivityLevels) => void;
  /** (0.34) The tiles the client watches (`tile.watchLines`) whose last line changed, each with its line
   *  now: to that client alone, at most every 250 ms. */
  "tile.lines": (change: { lines: LastLines }) => void;
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
  /** (0.43) A code question asked with an `ask` id has a better answer than the last one sent:
   *  the fastest first, then a more accurate one. To the asker alone. */
  "code.answered": (ask: number, answer: CodeAnswer) => void;
  /** Another writer changed a workspace's layouts: `part` is `core`, `board` or `view:<id>`; for the
   *  board, `objects` names the objects that changed (0.28; none: any may have). */
  "store.changed": (change: Pick<WorkspaceChange, "repo" | "part" | "objects">) => void;
  /** (0.43) A change to the board of `repo`, to whoever follows its changes (`board.changes`). */
  "board.changed": (repo: string, change: BoardChange) => void;
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
  "appearance.changed": (appearance: SharedAppearance) => void;
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

/** A code question about the editor's text rather than the file on disk, and the caller's version of it. */
export interface CodeAsk {
  text?: string;
  version?: number;
  /** The caller's id for this question: each better answer is sent as `code.answered` as it
   *  comes, and `code.cancel` with it takes the question back. */
  ask?: number;
}

/** Who a board write is written as: only this computer's window may name a view (`view:<id>`). */
export interface BoardWriter { writer: string }

export type Method = keyof WorkspaceMethods;
export type Params<M extends Method> = Parameters<WorkspaceMethods[M]>;
export type Result<M extends Method> = ReturnType<WorkspaceMethods[M]>;
export type Notice = keyof WorkspaceNotices;
export type NoticeParams<N extends Notice> = Parameters<WorkspaceNotices[N]>;
export type Event = keyof WorkspaceEvents;
export type EventParams<E extends Event> = Parameters<WorkspaceEvents[E]>;
