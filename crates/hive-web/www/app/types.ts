// What hive-phone's core hands the page (crates/hive-web/src/wasm.rs), as its serde makes it.

export interface Waiting {
  kind: string;
  since: number;
  plan?: string;
  decide?: boolean;
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
export type Reply = { text: string } | { allow: boolean } | { approve: boolean; feedback?: string };

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
