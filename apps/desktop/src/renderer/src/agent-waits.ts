/**
 * What each agent tile waits on, from the agent feed the window follows already (Workspace.tsx's
 * `agent.list` and `agent.changed`): its wait as the feed tells it (`AgentItem.waiting`). A row
 * reads one tile here (docs/design/last-line-2026-10-23.md §2).
 *
 * The feed tells every change of every agent, most of them of its state alone. A tile's entry is
 * given back as the same object while what a row says of it is the same (the wait's kind, `since`,
 * its tool and what that is about, its questions), so the row's listener is not called for the rest.
 */
import type { AgentItem } from "@hivemind/workspace-api/agents";

export type AgentWait = NonNullable<AgentItem["waiting"]>;

/** One agent tile, as a row shows it. */
export interface TileWait {
  /** What it waits on, while it waits. */
  waiting?: AgentWait;
}

const waits = new Map<string, TileWait>();
const listeners = new Map<string, Set<() => void>>();

const sameWait = (a: AgentWait | undefined, b: AgentWait | undefined): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.since === b.since && a.tool?.name === b.tool?.name && a.tool?.about === b.tool?.about
    && JSON.stringify(a.asks) === JSON.stringify(b.asks));

function put(tile: string, next: TileWait | undefined): void {
  if (next) waits.set(tile, next); else waits.delete(tile);
  for (const l of listeners.get(tile) ?? []) l();
}

/** The feed told `agent` as it is now. */
export function tellAgent(agent: AgentItem): void {
  const now = waits.get(agent.tile);
  if (now && sameWait(now.waiting, agent.waiting)) return;
  put(agent.tile, agent.waiting ? { waiting: agent.waiting } : {});
}

/** The agent in `tile` went. */
export function forgetAgent(tile: string): void {
  if (waits.has(tile)) put(tile, undefined);
}

/** The window follows another workspace's feed, or none: every agent here went. */
export function forgetAgents(): void {
  for (const tile of waits.keys()) put(tile, undefined);
}

/** `tile`'s entry now: the same object until what a row says of it changes. */
export function waitOf(tile: string): TileWait | undefined {
  return waits.get(tile);
}

/** Called each time `tile`'s entry changes. */
export function subscribeWait(tile: string, l: () => void): () => void {
  let set = listeners.get(tile);
  if (!set) listeners.set(tile, (set = new Set()));
  set.add(l);
  return () => {
    set!.delete(l);
    if (set!.size === 0 && listeners.get(tile) === set) listeners.delete(tile);
  };
}
