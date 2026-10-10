/**
 * A program the person lets drive workspaces on this machine (spec/workspace-api.md "Drive socket"):
 * its name, the workspaces it may reach, its role there, and until when. Its token is shown once,
 * when it is made; the host keeps only a hash of it.
 */
import type { Role } from "@hivemind/workspace-host/access";

export interface ClientGrant {
  id: string;
  name: string;
  /** The workspaces it may reach, by their folder here. */
  repos: string[];
  role: Role;
  /** Ms since the epoch. */
  createdAt: number;
  /** When it stops, ms since the epoch; null: never. */
  expires: number | null;
  /** When a program last connected with it; null: never. */
  lastUsed: number | null;
  /** The tool plugin whose service holds it, while the service runs. */
  plugin?: string;
}

/** What makes a grant. `expires`: ms since the epoch. */
export interface NewGrant {
  name: string;
  repos: string[];
  role: Role;
  expires?: number | null;
}
