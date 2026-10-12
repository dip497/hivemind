/**
 * What waits on the person (spec/needs.md, M5): each agent waiting on them in the workspaces this
 * device holds, as their phone lists it, the one waiting longest first. Electron-free: the
 * device's documents, its agents' statuses and what they wait on in, the list out.
 */
import path from "node:path";
import { agentForCmd, type AgentProviderDef, type AnswerKeys, type InputKind } from "@hivemind/agents";
import { machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import type { AccessLists } from "@hivemind/workspace-host/access";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import type { Asked, ToolAsked } from "@hivemind/workspace-api/agents";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { Wait } from "./waits.js";

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
  /** What it waits for, and what screen, when its agent's manifest names it (`trust`). */
  kind: InputKind;
  says?: string;
  /** When it began waiting, ms since the epoch: with `tile`, which wait this is. */
  since: number;
  /** A plan it waits on review of: the plan, in markdown. */
  plan?: string;
  /** What the machine it runs on is called (0.3). */
  machine: string;
  /** What it asks can be allowed or denied from the device (0.5), its agent saying which of its
   *  keys do. */
  decide?: true;
  /** A permission's tool, and what it is about, whole (0.7). */
  tool?: { name: string; about?: string };
  /** A question's questions, each with its options (0.7). */
  asks?: Asked[];
  /** An option of its one question is chosen from the device (0.7), its agent saying the keys. */
  choose?: true;
}

/** What the device knows of what each tile's agent waits on: whether its keys allow or deny it
 *  (`decides`), the plan or supervised tool use it waits on, the tool use its session file says it
 *  waits on, and whether its agent says the keys that choose an option. */
export interface WaitFacts {
  decides: Decides;
  wait?(tile: string): Wait | undefined;
  asking?(tile: string): ToolAsked | undefined;
  chooses?(tile: string): boolean;
}

/** What an agent waiting on the person waits on, as their devices are told it (0.7). A tool use
 *  that asks questions makes it a question, whatever its hooks call it, an option chosen from the
 *  device when it asks one question with one answer and its agent says the keys that choose; a
 *  permission says the tool it is for and what that is about, and is allowed or denied from the
 *  device when its agent says the keys. A screen it says it waits on (`says`) is that screen, of
 *  no tool. */
export function waitOn(tile: string, status: { kind: InputKind; says?: string }, facts: WaitFacts): Pick<Need, "kind" | "decide" | "tool" | "asks" | "choose"> {
  const asking = status.says || (status.kind !== "permission" && status.kind !== "question") ? undefined : facts.asking?.(tile);
  if (asking?.asks) {
    const [only, ...more] = asking.asks;
    const one = !!only && more.length === 0 && !only.many && only.options.length > 0;
    return { kind: "question", asks: asking.asks, ...(one && facts.chooses?.(tile) ? { choose: true as const } : {}) };
  }
  const tool = asking && status.kind === "permission" ? { tool: { name: asking.name, ...(asking.about ? { about: asking.about } : {}) } } : {};
  return { kind: status.kind, ...tool, ...(facts.decides(tile, status) ? { decide: true as const } : {}) };
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

/** The manifest of the agent the tile `tile` of `held` runs; undefined for a tile on none of
 *  them, and for a command no manifest here names. */
export function manifestOf(held: HeldBoard[], tile: string): AgentProviderDef | undefined {
  const bare = toBareId(tile);
  const record = held.flatMap((h) => h.core?.tiles ?? []).find((t) => t.id === bare);
  return agentForCmd(record?.cmd);
}

/** The keys that allow and deny a permission the agent of `tile` asks, as its manifest says: by
 *  what its screen says it is (`answer.trust`), else `answer.permission`. Undefined for a wait of
 *  another kind, one it says no keys for, and a tile on none of `held`. */
export function answerKeys(held: HeldBoard[], tile: string, status: { kind?: InputKind; says?: string }): AnswerKeys | undefined {
  return status.kind === "permission" ? manifestOf(held, tile)?.answer?.[status.says ?? "permission"] : undefined;
}

/** The folder the agent of `tile` runs in on `board`: its frame's worktree's, else its frame's,
 *  else its workspace's. */
export function folderOf(board: HeldBoard, tile: string): string {
  const id = board.core?.frameOf?.[tile];
  const frame = id === undefined ? undefined : board.core?.frames.find((f) => f.id === id);
  return frame?.worktreePath ?? frame?.workspacePath ?? board.repo;
}

/** The folder the agent of `tile` runs in, on whichever board of `held` it is; null for a tile on
 *  none of them. */
export function runsIn(held: HeldBoard[], tile: string): string | null {
  const bare = toBareId(tile);
  const board = held.find((h) => h.core?.tiles.some((t) => t.id === bare));
  return board ? folderOf(board, bare) : null;
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

/** Whether what the agent of `tile` waits on, by its status, can be allowed or denied from here:
 *  its agent says the keys that do (`answerKeys`). */
export type Decides = (tile: string, status: { kind?: InputKind; says?: string }) => boolean;

/** An agent's status, as much of it as says whether it waits on the person. */
export interface WaitingStatus {
  tileId: string;
  status: { state: string; kind?: InputKind; says?: string; since: number; title?: string; session?: string };
}

/** How many agents of `held` are at work now. */
export function workingIn(held: HeldBoard[], statuses: WaitingStatus[]): number {
  return statuses.filter(({ tileId, status }) => status.state === "working" && agentOf(held, tileId) !== null).length;
}

/** The agents of `held` waiting on the person, the one waiting longest first (and of two waiting
 *  since the same moment, the one whose tile comes first). An agent is called what the person
 *  named its tile, else what it says it is doing, else what it was started to do, else its tile's
 *  label; and the machine it runs on, as this device knows it (`machines`). What it waits on is as
 *  `waitOn` says. */
export function needsOf(held: HeldBoard[], statuses: WaitingStatus[], machines: KnownMachines, facts: WaitFacts): Need[] {
  const needs: Need[] = [];
  for (const { tileId, status } of statuses) {
    if (!waitsOnThePerson(status) || !status.kind) continue;
    const at = agentOf(held, tileId, status.title);
    if (!at) continue;
    const plan = status.kind === "plan" ? facts.wait?.(at.tile)?.plan : undefined;
    const board = held.find((h) => h.workspace === at.workspace)!;
    const machine = machineCalled(folderOf(board, at.tile), machines);
    const { kind, ...on } = waitOn(at.tile, { kind: status.kind, says: status.says }, facts);
    needs.push({ ...at, kind, ...(status.says ? { says: status.says } : {}), since: status.since, ...(plan === undefined ? {} : { plan }), machine, ...on });
  }
  return needs.sort((a, b) => a.since - b.since || (a.tile < b.tile ? -1 : a.tile > b.tile ? 1 : 0));
}
