// What hive-phone's core hands the page (crates/hive-web/src/wasm.rs), as its serde makes it.

export interface Waiting {
  kind: string;
  since: number;
  plan?: string;
  decide?: boolean;
  /** A permission's tool, and the exact command, file or address it is about. */
  tool?: { name: string; about?: string };
  /** A question's questions, each with its options. */
  asks?: Array<{ question: string; options: string[]; descriptions?: string[]; many?: boolean }>;
  /** An option of its one question is answered by choosing it. */
  choose?: boolean;
}

export interface Agent {
  /** The workspace's id, and its name. */
  workspace: string;
  name: string;
  tile: string;
  /** What the agent is called. */
  agent: string;
  program?: { id: string; label: string };
  state: string;
  since: number;
  machine: string;
  waiting?: Waiting;
  interrupt?: boolean;
  conversation?: boolean;
  device: string;
}

/** Every agent; what waits on the person, longest first; how many are at work. */
export interface Overview {
  agents: Agent[];
  needs: Agent[];
  working: number;
}

/** What pairing gave: the computer paired with, and this browser's certificate from it. */
export interface Paired {
  with: { device: string; name: string; relay: string | null; kind: string };
  /** Names the person whose devices both are. */
  certificate: { person: string };
  network: unknown;
  admission: string;
}

export interface Entry {
  id: string;
  at: number;
  who: "person" | "agent" | "tool" | "program";
  text?: string;
  tool?: { id: string; name: string; about?: string };
  result?: { of: string; text: string; error?: boolean };
  /** A line the agent's own program wrote, in the person's words. */
  notice?: { text: string; quiet?: boolean; detail?: string };
}

/** A tool use unfolded, as the computer answers `agent.tool`: what it is about and its input whole,
 *  and what it gave back once it has; `truncated` when cut. */
/** A slash command an agent takes at its prompt: its own, the person's or the project's. */
export interface SlashCommand {
  name: string;
  description?: string;
  from: "built-in" | "yours" | "project";
}

export interface Unfolded {
  name: string;
  about?: string;
  input?: string;
  result?: { text: string; error?: boolean };
  truncated?: boolean;
}

export interface Piece {
  entries: Entry[];
  cursor: number;
  session: string;
}

/** A message the computer took for an agent (`agent.send`): `held` until its turn ends, or typed in. */
export interface Sent {
  held: boolean;
}

/** The person's answer to a wait. */
export type Reply = { text: string } | { allow: boolean } | { approve: boolean; feedback?: string } | { answers: QuestionAnswer[] };

/** The answer to one question: the options chosen, by their place, or a line. */
export type QuestionAnswer = { chosen: number[] } | { text: string };

/** A view the computer offers this browser (`view.list`): `page` is the file that shows it. */
export interface Offered {
  id: string;
  name: string;
  version: string;
  entry: string;
  page: string;
}

/** One of a view's files, as the computer serves it (`view.file`), under `csp`. */
export interface ViewFile {
  data: Uint8Array;
  type: string;
  csp: string;
}

/** The screen a view is shown on: its size in CSS pixels, and the look it is given. */
export interface Screen {
  w: number;
  h: number;
  theme: Record<string, unknown>;
}

/** A note the person left on a page in a Browser tile (hive-phone's `notes::Note`). */
export interface PageNote {
  id: string;
  body: string;
  status: "open" | "seen" | "resolved" | "dismissed";
  /** What it points at: an element's name, or "Area". */
  what: string;
  url: string;
  /** What was done, or why it was dismissed. */
  summary?: string;
}

/** A workspace the computer holds. */
export interface Held {
  workspace: string;
  name: string;
  repo?: string;
}

/** An agent the computer can start (hive-phone's `control::StartProgram`). */
export interface Program {
  id: string;
  label: string;
  options: Array<{ id: string; label: string; values: string[] }>;
}

/** A folder an agent may be started in: a project of the workspace, or one opened lately. */
export interface PlaceFolder {
  path: string;
  name: string;
  kind: "project" | "recent";
  frame?: string;
}

/** Where an agent may be started in a workspace (hive-phone's `control::Places`). */
export interface Places {
  machines: Array<{ id: string; name: string; programs: Program[]; folders: PlaceFolder[]; unreached?: string }>;
}

/** The folders inside a project's folder (hive-phone's `control::Folders`). */
export interface Folders {
  path: string;
  folders: Array<{ name: string; path: string }>;
  more: boolean;
}

/** A photo for an agent to look at: its type and its bytes in base64. */
export interface Photo {
  type: string;
  data: string;
}

/** An agent to start: which, where, and with what. */
export interface Start {
  program: string;
  folder?: string;
  prompt?: string;
  model?: string;
  mode?: string;
  images?: Photo[];
}

/** The person's other computers and hosts, as the computer tells of them, and whose they are. */
export interface Others {
  whose: string | null;
  devices: Array<{ device: string; name: string; kind: string; relay: string | null }>;
}

/** A tile as Home holds it (spec/home.md): where the desktop lists it and, for an agent, what the
 *  agent list says of it. */
export interface HomeTile {
  workspace: string;
  id: string;
  frameId: string | null;
  kind: string;
  name: string;
  agent?: string;
  /** It runs a terminal: an agent's or a shell. */
  terminal?: boolean;
  order: number;
  pinned?: boolean;
  parent?: string;
  state?: string;
  since?: number;
  waiting?: Waiting;
  program?: { id: string; label: string };
  machine?: string;
  interrupt?: boolean;
  conversation?: boolean;
}

export interface HomeFrame {
  workspace: string;
  id: string;
  title: string;
  color: string;
  order: number;
  machine?: { name: string; state?: string };
  parentId?: string;
  branch?: string;
  folder?: { name: string; kind?: string };
  project?: string;
}

/** A project, frame or section's rows one level under it, the state among its tiles that most
 *  wants a look, and whether the person folded it. */
interface Folds {
  count: number;
  state?: string;
  folded: boolean;
}

/** One line of a list Home shows (hive-phone's `home::Entry`). */
export type HomeEntry =
  | { of: "machine"; key: string; name: string }
  | ({ of: "project"; key: string; name: string; workspace: string; frame?: string } & Folds)
  | ({ of: "frame"; key: string; depth: number; frame: HomeFrame } & Folds)
  | ({ of: "section"; key: string; label: string } & Folds)
  | { of: "tile"; key: string; depth: number; tile: HomeTile; line?: string; unread: boolean };

/** An agent's mark (hive-phone's `mark::Mark`): paths of absolute M, L, C, Q and Z in its box. */
export interface Mark {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `fill_color` and `stroke_color` are `#rrggbb`; null is the row's colour. */
  shapes: Array<{ d: string; fill: boolean; fill_color: string | null; even_odd: boolean; stroke: number; stroke_color: string | null; round: boolean; opacity: number }>;
}

/** Home as it shows (hive-phone's `home::Shown`). */
export interface Shown {
  /** What waits on the person, by tile key: each an agent of the overview. */
  needs: string[];
  working: HomeEntry[];
  pinned: HomeEntry[];
  machines: string[];
  tree: HomeEntry[];
  /** The mark of each agent a tile listed runs, by agent. */
  marks: Record<string, Mark>;
}
