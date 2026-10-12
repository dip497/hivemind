// What hive-phone's core hands the page (crates/hive-web/src/wasm.rs), as its serde makes it.

export interface Waiting {
  kind: string;
  since: number;
  plan?: string;
  decide?: boolean;
  /** A permission's tool, and the exact command, file or address it is about. */
  tool?: { name: string; about?: string };
  /** A question's questions, each with its options. */
  asks?: Array<{ question: string; options: string[]; many?: boolean }>;
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
  certificate: unknown;
  network: unknown;
  admission: string;
}

export interface Entry {
  id: string;
  at: number;
  who: "person" | "agent" | "tool";
  text?: string;
  tool?: { id: string; name: string; about?: string };
  result?: { of: string; text: string; error?: boolean };
}

export interface Piece {
  entries: Entry[];
  cursor: number;
  session: string;
}

/** The person's answer to a wait. */
export type Reply = { text: string } | { allow: boolean } | { approve: boolean; feedback?: string } | { choice: number };

/** A workspace the computer holds. */
export interface Held {
  workspace: string;
  name: string;
  repo?: string;
}

/** What may be started in a workspace (hive-phone's `control::Startable`). */
export interface Startable {
  programs: Array<{ id: string; label: string; options: Array<{ id: string; label: string; values: string[] }> }>;
  frames: Array<{ id: string; name: string; machine: string }>;
}

/** An agent to start: which, where, and with what. */
export interface Start {
  program: string;
  frame?: string;
  prompt?: string;
  model?: string;
  mode?: string;
}

/** The person's other computers and hosts, as the computer tells of them, and whose they are. */
export interface Others {
  whose: string | null;
  devices: Array<{ device: string; name: string; kind: string }>;
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

/** One line of a list Home shows (hive-phone's `home::Entry`). */
export type HomeEntry =
  | { of: "machine"; key: string; name: string }
  | { of: "project"; key: string; name: string; workspace: string }
  | { of: "frame"; key: string; depth: number; frame: HomeFrame }
  | { of: "tile"; key: string; depth: number; tile: HomeTile; line?: string };

/** Home as it shows (hive-phone's `home::Shown`). */
export interface Shown {
  /** What waits on the person, by tile key: each an agent of the overview. */
  needs: string[];
  working: HomeEntry[];
  pinned: HomeEntry[];
  machines: string[];
  tree: HomeEntry[];
}
