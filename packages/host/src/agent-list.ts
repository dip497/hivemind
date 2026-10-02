/**
 * Every agent in the workspaces this device holds, as the person's devices follow them (M5,
 * spec/agents.md "Following"): each agent with a status whose tile is on a board here, its state
 * and since when, what it waits on, the program it runs, the machine it runs on and whether its
 * turn can be interrupted from afar. Electron-free: the device's boards, its agents' statuses and
 * the plans they hand off in, the list out.
 */
import type { InputKind } from "@hivemind/agents";
import { machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { agentOf, folderOf, manifestOf, type HeldBoard, type WaitingStatus } from "./needs.js";

/** An agent here, as the person's devices are told of it. */
export interface AgentItem {
  /** The workspace it is in: its id, and its name. */
  workspace: string;
  name: string;
  tile: string;
  /** What it is called (spec/needs.md). */
  agent: string;
  /** The agent its tile runs, by its manifest. */
  program?: { id: string; label: string };
  /** Its status's state, and when that last changed (ms since the epoch). */
  state: string;
  since: number;
  /** What the machine it runs on is called (spec/needs.md 0.3). */
  machine: string;
  /** What it waits for, while it waits: on the person, or on the agent supervising it. */
  waiting?: { kind: InputKind; since: number; plan?: string; decide?: true };
  /** Its manifest says which keys interrupt its turn. */
  interrupt?: true;
}

/** What this device knows of the agent each tile runs. */
export interface AgentFacts {
  /** The program the tile's command starts, by its manifest; undefined for one none names. */
  program(tile: string): { id: string; label: string } | undefined;
  /** Whether a permission its agent asks can be allowed or denied from here (spec/needs.md 0.5). */
  decides(tile: string): boolean;
  /** Whether its agent says which keys interrupt its turn. */
  interrupts(tile: string): boolean;
}

/** What the manifests here say of the agent each tile of `held` runs. */
export function manifestFacts(held: HeldBoard[]): AgentFacts {
  return {
    program: (tile) => {
      const def = manifestOf(held, tile);
      return def && { id: def.id, label: def.label };
    },
    decides: (tile) => !!manifestOf(held, tile)?.answer?.permission,
    interrupts: (tile) => !!manifestOf(held, tile)?.interrupt,
  };
}

const byCodes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The agents of `held`, by their workspace's id, then their tile. */
export function agentsOf(held: HeldBoard[], statuses: WaitingStatus[], plans: PlanReview[], machines: KnownMachines, facts: AgentFacts): AgentItem[] {
  const items: AgentItem[] = [];
  for (const { tileId, status } of statuses) {
    const at = agentOf(held, tileId, status.title);
    if (!at) continue;
    const board = held.find((h) => h.workspace === at.workspace)!;
    const program = facts.program(at.tile);
    let waiting: AgentItem["waiting"];
    if (status.state === "waiting" && status.kind) {
      const plan = status.kind === "plan" ? plans.find((p) => toBareId(p.tileId) === at.tile)?.plan : undefined;
      const decide = status.kind === "permission" && facts.decides(at.tile);
      waiting = { kind: status.kind, since: status.since, ...(plan === undefined ? {} : { plan }), ...(decide ? { decide } : {}) };
    }
    items.push({
      ...at,
      ...(program ? { program } : {}),
      state: status.state,
      since: status.since,
      machine: machineCalled(folderOf(board, at.tile), machines),
      ...(waiting ? { waiting } : {}),
      ...(facts.interrupts(at.tile) ? { interrupt: true as const } : {}),
    });
  }
  return items.sort((a, b) => byCodes(a.workspace, b.workspace) || byCodes(a.tile, b.tile));
}
