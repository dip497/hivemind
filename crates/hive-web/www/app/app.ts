// What the screens ask of the app: to open an agent, and to act for the person, told when it
// did not land.

import type { Agent, Piece, Reply } from "./types.js";

export interface App {
  open(agent: Agent): void;
  back(): void;
  answer(agent: Agent, reply: Reply): Promise<boolean>;
  send(agent: Agent, text: string): Promise<boolean>;
  stop(agent: Agent): Promise<boolean>;
  conversation(agent: Agent, said: (p: Piece) => void, ended: (why: string) => void): () => void;
}
