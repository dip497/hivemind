// What the screens ask of the app: to open an agent, and to act for the person, told when it
// did not land.

import type { ViewSession } from "../pkg/hive_web.js";
import type { Agent, Held, Offered, Piece, Reply, Screen, Start, Startable, ViewFile } from "./types.js";

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
  /** The computer's name, as paired. */
  computer(): string;
  workspaces(): Promise<Held[]>;
  startable(workspace: string): Promise<Startable>;
  /** Start an agent: its tile, or null when it did not start (the person is told why). */
  start(workspace: string, start: Start): Promise<string | null>;
  /** The views the computer offers in `workspace`. */
  views(workspace: string): Promise<Offered[]>;
  viewFile(workspace: string, view: string, path: string): Promise<ViewFile>;
  openView(workspace: string, view: string, screen: Screen): Promise<ViewSession>;
  /** `reached` is called each time the computer is reached again, until what it returns is called. */
  onReach(reached: () => void): () => void;
}
