// What the screens ask of the app: to open an agent, and to act for the person, told when it
// did not land.

import type { TermSource } from "./terminal.js";
import type { Agent, Held, Piece, Reply, Start, Startable } from "./types.js";

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
  /** Watch the terminal of `tile` in `workspace`: `changed` when its screen may have changed,
   *  `ended` why it is shown no more. Null before the phone has started. */
  terminal(workspace: string, tile: string, changed: () => void, ended: (why: string) => void): { source: TermSource; stop: () => void } | null;
  /** Show the terminal of the tile `tile` in `workspace`, called `name`, one that runs no agent. */
  openTerminal(workspace: string, tile: string, name: string): void;
  /** The computer's name, as paired. */
  computer(): string;
  workspaces(): Promise<Held[]>;
  startable(workspace: string): Promise<Startable>;
  /** Start an agent: its tile, or null when it did not start (the person is told why). */
  start(workspace: string, start: Start): Promise<string | null>;
}
