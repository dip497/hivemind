/**
 * What the workspace API says about agents: their status, and the links drawn between them (a
 * pipe that carries one's reports to another, a spawn wire from a parent to the worker it
 * started). Node-free.
 */
import type { SessionStatus } from "@hivemind/agent-host/status-store";

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

/** An agent spawned another (a workflow's worker, `tile.spawn_agent`), or the wire between them
 *  went: drawn from parent to child whatever the pipes do. */
export interface SpawnChange {
  child: string;
  parent: string | null;
  connected: boolean;
}

/** The control plane opened a tile, before it reaches the layout: a client that shows `repo`
 *  starts it with `prompt`, and brings it forward unless it is a `background` worker. */
export interface TileOpened {
  tileId: string;
  repo: string;
  prompt?: string;
  background: boolean;
}

/** What a person answers an agent waiting on them (M5): a plan's decision, or one line typed into
 *  its terminal. */
export type AgentAnswer = { text: string } | { decision: "allow" | "deny"; feedback?: string };

/** What may be started in a workspace (M5, spec/agents.md "Starting"): the agents a device starts,
 *  with their model and mode choices (`values` empty: one taken as typed), and the workspace's
 *  frames, with the machine each one's folder is on. */
export interface Startable {
  programs: Array<{ id: string; label: string; options: Array<{ id: string; label: string; values: string[] }> }>;
  frames: Array<{ id: string; name: string; machine: string }>;
}

/** An agent to start, as the person launches one at their desktop. */
export interface StartAgent {
  program: string;
  frame?: string;
  prompt?: string;
  model?: string;
  mode?: string;
}

/** One thing said in an agent's conversation (spec/agents.md "Conversation"): by the person, by
 *  the agent (its text, in markdown, or a tool it used), or by a tool (what it gave back). */
export type ConversationEntry =
  | { id: string; at: number; who: "person" | "agent"; text: string }
  | { id: string; at: number; who: "agent"; tool: { id: string; name: string; about?: string } }
  | { id: string; at: number; who: "tool"; result: { of: string; text: string; error?: true } };

/** What an agent changed in the folder it runs in, against its last commit (spec/agents.md
 *  "Changes"). */
export interface AgentChanges {
  files: Array<{ path: string; status: string; added: number; removed: number }>;
  patch: string;
  truncated: boolean;
}

/** Every link there is now. */
export interface Links {
  pipes: Array<{ src: string; dst: string }>;
  spawns: Array<{ parent: string; child: string }>;
}
