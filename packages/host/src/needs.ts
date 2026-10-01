/**
 * What waits on the person (spec/needs.md, M5): each agent waiting on them in the workspaces this
 * device holds, as their phone lists it, the one waiting longest first. Electron-free: the
 * device's documents, its agents' statuses and the plans they hand off in, the list out.
 */
import type { InputKind } from "@hivemind/agents";

/** What an agent can wait on the person for. One waiting for an `approval` waits on the agent
 *  that supervises it, not on the person. */
const ON_THE_PERSON: readonly InputKind[] = ["permission", "question", "plan", "other"];
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import { toBareId } from "@hivemind/workspace-api/tile-id";

/** An agent waiting on the person. */
export interface Need {
  /** The workspace it is in: its id, and its name. */
  workspace: string;
  name: string;
  tile: string;
  /** What the agent is called. */
  agent: string;
  /** What it waits for. */
  kind: InputKind;
  /** When it began waiting, ms since the epoch: with `tile`, which wait this is. */
  since: number;
  /** A plan it waits on review of: the plan, in markdown. */
  plan?: string;
}

/** A workspace this device holds: its id, its name, and its board as its document has it. */
export interface HeldBoard {
  workspace: string;
  name: string;
  core: CoreLayout | null;
}

/** An agent's status, as much of it as says whether it waits on the person. */
export interface WaitingStatus {
  tileId: string;
  status: { state: string; kind?: InputKind; since: number; title?: string };
}

/** The agents of `held` waiting on the person, the one waiting longest first (and of two waiting
 *  since the same moment, the one whose tile comes first). An agent is called what the person
 *  named its tile, else what it says it is doing, else what it was started to do, else its tile's
 *  label. */
export function needsOf(held: HeldBoard[], statuses: WaitingStatus[], plans: PlanReview[]): Need[] {
  const needs: Need[] = [];
  for (const { tileId, status } of statuses) {
    if (status.state !== "waiting" || !status.kind || !ON_THE_PERSON.includes(status.kind)) continue;
    const tile = toBareId(tileId);
    const board = held.find((h) => h.core?.tiles.some((t) => t.id === tile));
    const record = board?.core?.tiles.find((t) => t.id === tile);
    if (!board || !record) continue;
    const agent = board.core?.tileNames?.[tile] || status.title || record.task || record.label;
    const plan = status.kind === "plan" ? plans.find((p) => toBareId(p.tileId) === tile)?.plan : undefined;
    needs.push({ workspace: board.workspace, name: board.name, tile, agent, kind: status.kind, since: status.since, ...(plan === undefined ? {} : { plan }) });
  }
  return needs.sort((a, b) => a.since - b.since || (a.tile < b.tile ? -1 : a.tile > b.tile ? 1 : 0));
}
