/**
 * Every agent in the workspaces this device holds, as the person's devices follow them (M5,
 * spec/agents.md "Following"): each agent with a status whose tile is on a board here, its state
 * and since when, what it waits on, the program it runs, the machine it runs on, whether its turn
 * can be interrupted from afar, whether it keeps a conversation this device can read, and the
 * session it is in.
 * Electron-free: the device's boards, its agents' statuses and what they wait on in, the list out.
 */
import type { InputKind } from "@hivemind/agents";
import { machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import { askingOf, keepsConversation } from "./conversations.js";
import { agentOf, answerKeys, folderOf, manifestOf, waitOn, type Decides, type HeldBoard, type WaitingStatus } from "./needs.js";
import type { ToolAsked } from "@hivemind/workspace-api/agents";
import type { Wait } from "./waits.js";

export type { AgentItem } from "@hivemind/workspace-api/agents";

/** What this device knows of the agent each tile runs. */
export interface AgentFacts {
  /** The program the tile's command starts, by its manifest; undefined for one none names. */
  program(tile: string): { id: string; label: string } | undefined;
  /** Whether what its agent waits on can be allowed or denied from here (spec/needs.md 0.5). */
  decides: Decides;
  /** Whether its agent says which keys interrupt its turn. */
  interrupts(tile: string): boolean;
  /** Whether its agent's manifest maps its session file's records (`session.transcript`). */
  converses(tile: string): boolean;
  /** Who started it and hears its reports, when one does. */
  parent?(tile: string): string | undefined;
  /** The plan or supervised tool use it waits on an answer for, if it waits on one. */
  wait?(tile: string): Wait | undefined;
  /** The tool use its session file says it waits on (spec/needs.md 0.7). */
  asking?(tile: string): ToolAsked | undefined;
  /** What its own hook said its tool use asks, after the hook let go. */
  asked?(tile: string): ToolAsked | undefined;
  /** Whether its agent says the keys that choose an option of a question its tool asks. */
  chooses?(tile: string): boolean;
}

/** What the manifests here say of the agent each tile of `held` runs, and, given the folder its
 *  sessions are recorded in (`TILE_SESSIONS_DIR`), the tool use its session file says it waits on. */
export function manifestFacts(held: HeldBoard[], tileSessionsDir?: string): AgentFacts {
  return {
    ...(tileSessionsDir ? { asking: (tile: string) => askingOf(held, tile, tileSessionsDir) } : {}),
    chooses: (tile) => !!manifestOf(held, tile)?.choose,
    program: (tile) => {
      const def = manifestOf(held, tile);
      return def && { id: def.id, label: def.label };
    },
    decides: (tile, status) => !!answerKeys(held, tile, status),
    interrupts: (tile) => !!manifestOf(held, tile)?.interrupt,
    converses: (tile) => keepsConversation(manifestOf(held, tile)),
  };
}

const byCodes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The agents of `held`, by their workspace's id, then their tile. */
export function agentsOf(held: HeldBoard[], statuses: WaitingStatus[], machines: KnownMachines, facts: AgentFacts): AgentItem[] {
  const items: AgentItem[] = [];
  for (const { tileId, status } of statuses) {
    const at = agentOf(held, tileId, status.title);
    if (!at) continue;
    const board = held.find((h) => h.workspace === at.workspace)!;
    const program = facts.program(at.tile);
    let waiting: AgentItem["waiting"];
    if (status.state === "waiting" && status.kind) {
      const held = facts.wait?.(at.tile);
      const wait = held?.kind === status.kind ? held : undefined;
      const { kind, ...on } = waitOn(at.tile, { kind: status.kind, says: status.says, since: status.since }, facts);
      waiting = {
        kind, ...(status.says ? { says: status.says } : {}), since: status.since, ...(wait?.plan === undefined ? {} : { plan: wait.plan }), ...on,
        ...(wait?.kind === "approval" ? { approval: { request: wait.request, tool: wait.tool!, summary: wait.summary!, expiresAt: wait.expiresAt! } } : {}),
      };
    }
    const parent = facts.parent?.(at.tile);
    items.push({
      ...at,
      ...(program ? { program } : {}),
      ...(parent ? { parent } : {}),
      state: status.state,
      since: status.since,
      machine: machineCalled(folderOf(board, at.tile), machines),
      ...(waiting ? { waiting } : {}),
      ...(facts.interrupts(at.tile) ? { interrupt: true as const } : {}),
      ...(facts.converses(at.tile) ? { conversation: true as const } : {}),
      ...(status.session ? { session: status.session } : {}),
    });
  }
  return items.sort((a, b) => byCodes(a.workspace, b.workspace) || byCodes(a.tile, b.tile));
}
