// What the screens ask of the app: to open an agent, and to act for the person, told when it
// did not land.

import type { ViewSession } from "../pkg/hive_web.js";
import type { TermSource } from "./terminal.js";
import type { Agent, Folders, Held, Offered, Piece, Places, Reply, Screen, Start, Unfolded, ViewFile } from "./types.js";

export interface App {
  /** Show the agent of `tile`; Back comes back here. */
  open(tile: string): void;
  back(): void;
  /** Whether it landed; null when the computer did not say. */
  answer(agent: Agent, reply: Reply): Promise<boolean | null>;
  send(agent: Agent, text: string): Promise<boolean>;
  stop(agent: Agent): Promise<boolean>;
  close(agent: Agent): Promise<boolean>;
  conversation(agent: Agent, said: (p: Piece) => void, ended: (why: string) => void): () => void;
  /** The tool use `use` of `agent`, unfolded. */
  tool(agent: Agent, use: string): Promise<Unfolded>;
  /** Watch the terminal of `tile` in `workspace`: `changed` when its screen may have changed,
   *  `ended` why it is shown no more. Null before the phone has started. */
  terminal(workspace: string, tile: string, changed: () => void, ended: (why: string) => void): { source: TermSource; stop: () => void } | null;
  /** Show the terminal of the tile `tile` in `workspace`, called `name`, one that runs no agent. */
  openTerminal(workspace: string, tile: string, name: string): void;
  /** The computer's name, as paired. */
  computer(): string;
  workspaces(): Promise<Held[]>;
  places(workspace: string): Promise<Places>;
  folders(workspace: string, folder: string): Promise<Folders>;
  /** Start an agent: its tile, or null when it did not start (the person is told why). */
  start(workspace: string, start: Start): Promise<string | null>;
  /** The views the computer offers in `workspace`. */
  views(workspace: string): Promise<Offered[]>;
  viewFile(workspace: string, view: string, path: string): Promise<ViewFile>;
  openView(workspace: string, view: string, screen: Screen): Promise<ViewSession>;
  /** `reached` is called each time the computer is reached again, until what it returns is called. */
  onReach(reached: () => void): () => void;
}
