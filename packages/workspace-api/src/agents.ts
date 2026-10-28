/**
 * What the workspace API says about agents: their status, and the links between them (a
 * pipe that carries one's reports to another, a spawn wire from a parent to the worker it
 * started). Node-free.
 */
import type { SessionStatus } from "@hivemind/agent-host/status-store";

type InputKind = NonNullable<SessionStatus["kind"]>;

/** A change to an agent session's status. `tileId` is the bare tile id; `seq` orders changes. */
export interface StatusChange {
  seq: number;
  tileId: string;
  status: SessionStatus;
}

/** A pipe from `src` to `dst` connected, or cut (`dst` null: every pipe from `src`). */
export interface PipeChange {
  src: string;
  dst: string | null;
  connected: boolean;
}

/** An agent spawned another (a workflow's worker, `hive ctl spawn`), or the link between them
 *  went: from parent to child whatever the pipes do. */
export interface SpawnChange {
  child: string;
  parent: string | null;
  connected: boolean;
}

/** The control plane opened a tile, before it reaches the layout, and its host starts it: a client
 *  that shows `repo` lays it out beside `near`, the agent tile that opened it, when both share a
 *  frame. It brings forward one the person opened (`by` person, 0.33); one an agent or a program
 *  opened as its person's setting says (`agents.whenAgentStartsAgent`); a `background` worker never. */
export interface TileOpened {
  tileId: string;
  repo: string;
  background: boolean;
  near?: string;
  by: "person" | "agent" | "program";
}

/** Who answered a wait: a person, by their id and name. */
export interface Answerer {
  person: string;
  name: string;
}
/** What a person answers an agent waiting on them (M5): a plan's decision, or one line typed into
 *  its terminal. */
/** A line typed, or a decision; `always` (0.23): a supervised tool use decided so from now on, for
 *  every use of that tool by that agent. */
export type AgentAnswer = { text: string } | { decision: "allow" | "deny"; feedback?: string; always?: true } | { answers: QuestionAnswer[] };

/** The answer to one question a wait asks (`asks`): the options chosen, by their place from 0
 *  (one, unless several may be), or a line. */
export type QuestionAnswer = { chosen: number[] } | { text: string };

/** What may be started in a workspace (M5, spec/agents.md "Starting"): the agents a device starts,
 *  with their model and mode choices (`values` empty: one taken as typed), and the workspace's
 *  frames, with the machine each one's folder is on. */
export interface Startable {
  programs: StartableProgram[];
  frames: Array<{ id: string; name: string; machine: string }>;
}

export interface StartableProgram {
  id: string;
  label: string;
  options: Array<{ id: string; label: string; values: string[] }>;
}

/** Where an agent may be started in a workspace (spec/agents.md 0.8 "Places"): each machine its
 *  projects are on, this computer first (`id` ""), with the agents found there; `unreached`, why
 *  none could be asked. A folder is a path here, or a `machine://` uri. */
export interface Places {
  machines: Array<{ id: string; name: string; programs: StartableProgram[]; folders: PlaceFolder[]; unreached?: string }>;
}

/** A project of the workspace (its own folder, or a frame's, `frame`), or a folder the person
 *  opened lately. */
export interface PlaceFolder {
  path: string;
  name: string;
  kind: "project" | "recent";
  frame?: string;
}

/** The folders in a project's folder `path`, by name, at most `FOLDERS_MAX`; `more` when there are
 *  more. */
export interface Folders {
  path: string;
  folders: Array<{ name: string; path: string }>;
  more?: true;
}

/** A photo given with a prompt: its type and its bytes in base64. */
export interface StartImage {
  type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

/** An agent to start, as the person launches one at their desktop. `name`: its tile's. `resume`: a
 *  session of its to go on with. `supervise` (0.20): the tools it asks its starter before using,
 *  `true` for the usual ones or `"all"`, each asked as an approval wait (`agent.answer`); a program
 *  that starts it is its starter. `report`: false for a worker gathered in bulk, which its starter
 *  is not told of as it reports. */
/** What `agent.sleep` did: the agents put to sleep, and those left as they were, and why. */
export interface SleepAnswer { slept: string[]; skipped: Skipped[] }
/** What `agent.wake` did: the agents woken, and those left as they were, and why. */
export interface WakeAnswer { woke: string[]; skipped: Skipped[] }
/** A tile left as it was, and why; `already` when it was as asked already (asleep, or awake) (0.33). */
export interface Skipped { tile: string; why: string; already?: true }

export interface StartAgent {
  program: string;
  frame?: string;
  /** (0.8) A folder of `agent.places`, or one `agent.folders` lists: it runs in the frame there,
   *  one opened for it when there is none. Not with `frame`. */
  folder?: string;
  /** (0.8) Photos for it to look at: kept on its machine, their paths after the prompt. */
  images?: StartImage[];
  prompt?: string;
  model?: string;
  mode?: string;
  name?: string;
  resume?: string;
  supervise?: true | "all" | string[];
  report?: boolean;
}

/** A supervised tool use waiting on an answer (0.20): which tool, what it would do, and when it
 *  stops waiting, falling back to the agent's own prompt. */
export interface ApprovalWait {
  request: string;
  tool: string;
  summary: string;
  expiresAt: number;
}

/** One thing said in an agent's conversation (spec/agents.md "Conversation"): by the person, by
 *  the agent (its text, in markdown, or a tool it used), or by a tool (what it gave back). */
/** A question an agent's tool asks the person, and the options to choose from; `descriptions`: what
 *  each option means, by its place (0.10); `many`: several may be chosen (spec/agents.md
 *  "Conversation", spec/needs.md 0.7). */
export interface Asked {
  question: string;
  options: string[];
  descriptions?: string[];
  many?: true;
}

/** The tool use an agent waits on the person for (spec/needs.md 0.7): its name, what it is about
 *  (the exact command, file or address, whole), and the questions it asks. */
export interface ToolAsked {
  name: string;
  about?: string;
  asks?: Asked[];
}

export type ConversationEntry =
  | { id: string; at: number; who: "person" | "agent"; text: string }
  | { id: string; at: number; who: "agent"; tool: { id: string; name: string; about?: string; asks?: Asked[] } }
  | { id: string; at: number; who: "tool"; result: { of: string; text: string; error?: true } };

/** A tool use unfolded (spec/agents.md 0.9): its name, what it is about and its input whole, and
 *  what it gave back once it has; each cut to `TOOL_MAX` characters, `truncated` then. */
export interface ToolUse {
  name: string;
  about?: string;
  input?: string;
  result?: { text: string; error?: true };
  truncated?: true;
}

/** The supervised tool use an agent waits on (0.31): the wait (`request`, `since`), the tool, its
 *  summary as its supervisor is told it, and its input whole as the agent's hook gave it (text as
 *  it is, else JSON), cut to `TOOL_MAX` characters, `truncated` then. */
export interface Approval {
  request: string;
  since: number;
  tool: string;
  summary: string;
  input: string;
  expiresAt: number;
  truncated?: true;
}

/** What an agent changed in the folder it runs in, against its last commit (spec/agents.md
 *  "Changes"). */
export interface AgentChanges {
  files: Array<{ path: string; status: string; added: number; removed: number }>;
  patch: string;
  truncated: boolean;
}

/** An agent's reply to the turn after the last message it was sent (0.23): `text` null when the
 *  turn carried none (`note` says why), it is still working when the wait ran out (`timeout`) or,
 *  read without waiting, now (`working`, 0.33), it was sent nothing since its last reply was read
 *  and is not working (`idle`, 0.33), it stopped to wait on an answer (`waiting`, what on, 0.26),
 *  or its tile closed or its agent exited (`closed`). One asleep is refused `ASLEEP` (0.33). */
export interface AgentRead {
  text: string | null;
  finalStatus: "turn" | "timeout" | "working" | "idle" | "closed" | "waiting";
  truncated: boolean;
  note?: string;
  waiting?: NonNullable<AgentItem["waiting"]>;
}

/** What another agent has for an agent (0.26): a turn's reply, a report, that it waits on an
 *  answer, or an approval it asks. */
export type InboxKind = "reply" | "report" | "waiting" | "approval";

/** One message in an agent's inbox, numbered across the machine in the order they came. */
export interface InboxMessage {
  id: number;
  at: number;
  /** The tile whose agent it is from, and what it is called. */
  from: string;
  name: string;
  kind: InboxKind;
  /** The turn of `from` it is the reply of. */
  turn?: number;
  text: string;
}

/** The sessions an agent keeps in a folder, newest first (0.23). */
export interface AgentSessions {
  agent: string;
  /** Whether `agent.start`'s `resume` can go on with one. */
  resumable: boolean;
  sessions: Array<{ id: string; cwd?: string; title?: string; prompt?: string; updated?: number }>;
}

/** A slash command an agent takes at its prompt (0.36): `from`, whose it is. */
export interface SlashCommand {
  name: string;
  description?: string;
  from: "built-in" | "yours" | "project";
}

/** Every link there is now. */
export interface Links {
  pipes: Array<{ src: string; dst: string }>;
  spawns: Array<{ parent: string; child: string }>;
}

/** An agent here, as the person's devices are told of it. */
export interface AgentItem {
  /** The workspace it is in: its id, and its name. */
  workspace: string;
  name: string;
  tile: string;
  /** What it is called (spec/needs.md). */
  agent: string;
  /** The agent its tile runs, by its manifest. */
  program?: { id: string; label: string };
  /** Its status's state, and when that last changed (ms since the epoch). */
  state: string;
  since: number;
  /** What the machine it runs on is called (spec/needs.md 0.3). */
  machine: string;
  /** What it waits for, while it waits: on the person, or on the agent supervising it. `says`: what
   *  screen, when its agent's manifest names it (`trust`); `decide`: it is allowed or denied with
   *  `agent.answer`'s decision, its agent saying the keys that do. */
  waiting?: { kind: InputKind; says?: string; since: number; plan?: string; decide?: true; approval?: ApprovalWait; tool?: { name: string; about?: string }; asks?: Asked[]; choose?: true };
  /** Who started it, when it reports to them (0.20): an agent's tile, or `client:<grant id>`, a
   *  program on the drive socket. */
  parent?: string;
  /** Its manifest says which keys interrupt its turn. */
  interrupt?: true;
  /** Its manifest maps its session file's records, so `agent.conversation` can say what it and the
   *  person said (spec/agents.md 0.4). */
  conversation?: true;
  /** The session it is in, as its agent last said (0.6): `agent.start`'s `resume` goes on with it. */
  session?: string;
}

/** What happened to an agent, as a reader acts on it. */
export type AgentEventKind = "came" | "went" | "turnEnded" | "waiting" | "answered" | "reported";
export interface AgentEvent {
  seq: number;
  at: number;
  kind: AgentEventKind;
  tile: string;
  /** turnEnded: how (done, failed, interrupted, limited). waiting: on what. answered: the
   *  decision a plan or supervised tool use got (0.21). reported (0.20): what it reported to the
   *  program that started it. */
  detail?: string;
  /** answered (0.21): the person who answered, when one did. */
  by?: Answerer;
}

/** One numbered change: an agent as it is now, or its going. */
export type AgentChange = { seq: number; agent: AgentItem } | { seq: number; gone: string };
