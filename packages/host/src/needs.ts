/**
 * What waits on the person (spec/needs.md, M5): each agent waiting on them in the workspaces this
 * device holds, as their phone lists it, the one waiting longest first. Electron-free: the
 * device's documents, its agents' statuses and the plans they hand off in, the list out.
 */
import path from "node:path";
import { agentForCmd, type InputKind, type PermissionKeys } from "@hivemind/agents";
import { machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import type { AccessLists } from "@hivemind/workspace-host/access";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import { toBareId } from "@hivemind/workspace-api/tile-id";

/** What an agent can wait on the person for. One waiting for an `approval` waits on the agent
 *  that supervises it, not on the person. */
const ON_THE_PERSON: readonly InputKind[] = ["permission", "question", "plan", "other"];

/** Whether an agent whose status is `status` waits on the person now. */
export const waitsOnThePerson = (status: { state: string; kind?: InputKind }): boolean =>
  status.state === "waiting" && !!status.kind && ON_THE_PERSON.includes(status.kind);

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
  /** What the machine it runs on is called (0.3). */
  machine: string;
  /** A permission the device can allow or deny (0.5), its agent saying which of its keys do. */
  decide?: true;
}

/** A workspace this device holds: its id, its name, its folder (here, or on the device it was
 *  moved from, M3), and its board as its document has it. */
export interface HeldBoard {
  workspace: string;
  name: string;
  repo: string;
  core: CoreLayout | null;
}

/** The workspaces `store` holds, with their boards. */
export function heldBoards(store: Pick<WorkspaceStore, "repos" | "ownership" | "getCore">): HeldBoard[] {
  return store.repos().flatMap((repo) => {
    const workspace = store.ownership(repo)?.workspaceId;
    return workspace ? [{ workspace, name: path.basename(repo), repo, core: store.getCore(repo) }] : [];
  });
}

/** Which agent of `held` the tile `tileId` is: its workspace, and what it is called (what the
 *  person named its tile, else what it says it is doing, `title`, else what it was started to do,
 *  else its tile's label); null for a tile in none of them. */
export function agentOf(held: HeldBoard[], tileId: string, title?: string): { workspace: string; name: string; tile: string; agent: string } | null {
  const tile = toBareId(tileId);
  const board = held.find((h) => h.core?.tiles.some((t) => t.id === tile));
  const record = board?.core?.tiles.find((t) => t.id === tile);
  if (!board || !record) return null;
  return { workspace: board.workspace, name: board.name, tile, agent: board.core?.tileNames?.[tile] || title || record.task || record.label };
}

/** The keys that allow and deny a permission the agent of `tile` asks, as its manifest says
 *  (`answer.permission`); undefined for an agent that says none, and for a tile on none of `held`. */
export function permissionKeys(held: HeldBoard[], tile: string): PermissionKeys | undefined {
  const bare = toBareId(tile);
  const record = held.flatMap((h) => h.core?.tiles ?? []).find((t) => t.id === bare);
  return agentForCmd(record?.cmd)?.answer?.permission;
}

/** The folder the agent of `tile` runs in on `board`: its frame's worktree's, else its frame's,
 *  else its workspace's. */
function folderOf(board: HeldBoard, tile: string): string {
  const id = board.core?.frameOf?.[tile];
  const frame = id === undefined ? undefined : board.core?.frames.find((f) => f.id === id);
  return frame?.worktreePath ?? frame?.workspacePath ?? board.repo;
}

/** Whose computer `device` is among the people let into a workspace here (M4): the name of the one
 *  who showed a certificate for it ("" when they gave none); undefined for a device on no list. */
export function participantNamed(lists: Pick<AccessLists, "workspaces" | "people">, device: string): string | undefined {
  for (const workspace of lists.workspaces()) {
    const person = lists.people(workspace).find((p) => p.devices.includes(device));
    if (person) return person.name;
  }
  return undefined;
}

/** An agent's status, as much of it as says whether it waits on the person. */
export interface WaitingStatus {
  tileId: string;
  status: { state: string; kind?: InputKind; since: number; title?: string };
}

/** How many agents of `held` are at work now. */
export function workingIn(held: HeldBoard[], statuses: WaitingStatus[]): number {
  return statuses.filter(({ tileId, status }) => status.state === "working" && agentOf(held, tileId) !== null).length;
}

/** The agents of `held` waiting on the person, the one waiting longest first (and of two waiting
 *  since the same moment, the one whose tile comes first). An agent is called what the person
 *  named its tile, else what it says it is doing, else what it was started to do, else its tile's
 *  label; and the machine it runs on, as this device knows it (`machines`). A permission is one it
 *  can decide when `decides` says so of the agent's tile. */
export function needsOf(held: HeldBoard[], statuses: WaitingStatus[], plans: PlanReview[], machines: KnownMachines, decides: (tile: string) => boolean): Need[] {
  const needs: Need[] = [];
  for (const { tileId, status } of statuses) {
    if (!waitsOnThePerson(status) || !status.kind) continue;
    const at = agentOf(held, tileId, status.title);
    if (!at) continue;
    const plan = status.kind === "plan" ? plans.find((p) => toBareId(p.tileId) === at.tile)?.plan : undefined;
    const board = held.find((h) => h.workspace === at.workspace)!;
    const machine = machineCalled(folderOf(board, at.tile), machines);
    const decide = status.kind === "permission" && decides(at.tile);
    needs.push({ ...at, kind: status.kind, since: status.since, ...(plan === undefined ? {} : { plan }), machine, ...(decide ? { decide } : {}) });
  }
  return needs.sort((a, b) => a.since - b.since || (a.tile < b.tile ? -1 : a.tile > b.tile ? 1 : 0));
}
