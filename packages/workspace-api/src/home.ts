/**
 * Home, as the person's phone follows it (spec/home.md): the Layers panel's rows, each keyed, in
 * two sequences, one for the board and the agents on it (`layout`), one for what each tile last
 * printed (`lines`).
 */
import type { ViewFrameFolder, ViewFrameMachine } from "@hivemind/view-sdk/protocol";
import type { AgentItem } from "./agents.ts";

/** A workspace held here: its id and its name. Keyed `w:<workspace>`. */
export interface HomeWorkspace {
  of: "workspace";
  workspace: string;
  name: string;
}

/** A frame of a workspace's board, as the view protocol's `structure` gives it. Keyed
 *  `f:<workspace>/<frame>`. */
export interface HomeFrame {
  of: "frame";
  workspace: string;
  id: string;
  title: string;
  color: string;
  /** Where the board lists it, from 0. */
  order: number;
  machine?: ViewFrameMachine;
  parentId?: string;
  branch?: string;
  folder?: ViewFrameFolder;
  /** A top frame's project, as the Layers panel names it, when it runs in a folder on this
   *  computer other than the workspace's own; left out for the workspace's own project. */
  project?: string;
}

/** A tile of a workspace's board: its `structure` tile, where the desktop's Layers panel lists it
 *  (`order`, from 0; `pinned`), and for an agent what the agent list says of it. Keyed
 *  `t:<workspace>/<tile>`. */
export interface HomeTile {
  of: "tile";
  workspace: string;
  id: string;
  frameId: string | null;
  kind: string;
  name: string;
  agent?: string;
  /** It runs a terminal, which can be shown and typed into. */
  terminal?: true;
  order: number;
  pinned?: true;
  /** The tile that started it, when it is listed under that one. */
  parent?: string;
  state?: AgentItem["state"];
  since?: number;
  waiting?: AgentItem["waiting"];
  /** For an agent, as the agent list says: what runs it, the machine it runs on, and whether its
   *  turn can be interrupted and its conversation read. */
  program?: AgentItem["program"];
  machine?: string;
  interrupt?: true;
  conversation?: true;
}

/** An agent a tile of a board runs, by its id (a tile's `agent`): what it is called, and its mark
 *  as its manifest draws it, in one colour. Keyed `a:<id>`. */
export interface HomeAgent {
  of: "agent";
  id: string;
  label: string;
  icon: { viewBox: string; attrs?: Record<string, string>; shapes: Array<Record<string, Record<string, string | number>>> };
}

export type HomeRow = HomeWorkspace | HomeFrame | HomeTile | HomeAgent;

/** One keyed row that changed (`row`) or went (`gone`), numbered in its sequence. */
export type KeyedChange<T> = { seq: number; key: string; row: T } | { seq: number; key: string; gone: true };

/** A sequence's rows now, and its position. */
export interface KeyedSnapshot<T> {
  seq: number;
  rows: Array<[string, T]>;
}

/** How the computer looks, for the phone to look the same (0.5): its theme's colours, each
 *  `#rrggbb`, its terminal's, and its wallpaper. Never a file of the computer's. */
export interface HomeLook {
  mode: "dark" | "light";
  /** The palette's tokens, and the accent's `brand` and `accent`. */
  colors: Record<string, string>;
  /** `background`, `foreground`, `cursor`, `selection`, then `ansi`: the 16 in xterm's order. */
  terminal: { background: string; foreground: string; cursor: string; selection: string; ansi: string[] };
  /** A built-in wallpaper's id (`none` for none), and whether a live one is in its own colours. */
  wallpaper: { kind: string; colour: boolean };
}

/** What the `home` stream answers: both sequences whole, or what came after the positions given;
 *  and the look, whole, in every answer to a follow and whenever it changes. */
export type HomeMessage =
  | { t: "home"; layout: KeyedSnapshot<HomeRow>; lines: KeyedSnapshot<string>; look?: HomeLook }
  | { t: "changes"; layout?: { seq: number; changes: KeyedChange<HomeRow>[] }; lines?: { seq: number; changes: KeyedChange<string>[] }; look?: HomeLook };
