/**
 * What `hive ctl agents` and `hive ctl tiles` print of a workspace: each row named as the flags
 * that set it and the glossary say. `name` is the tile's name (`spawn --name`), `agent` the program
 * it runs (`spawn --agent`), `workspace` the workspace's id and name, and an agent put to sleep is
 * `asleep`. The host's agent list is the phone's too, so its own field names stay as they are.
 * `line` is the tile's last line, as its Layers row says it: for an agent that keeps a
 * conversation, what it last said; else what its screen last showed (`tile.readLines`).
 */
import type { AgentItem } from "@hivemind/workspace-api/agents";
import type { Result } from "@hivemind/workspace-api/methods";
import { agentForCmd } from "@hivemind/agents";

type Core = NonNullable<Result<"store.core">>;
type TileRecord = Core["tiles"][number];

/** One agent of the workspace. */
export interface AgentRow {
  tile: string;
  /** The tile's name. */
  name: string;
  /** The program it runs, by its id, as `spawn --agent` takes it. */
  agent?: string;
  workspace: { id: string; name: string };
  /** idle, working, waiting, done, failed, interrupted, limited, exited, or asleep. */
  state: string;
  since: number;
  machine: string;
  waiting?: AgentItem["waiting"];
  parent?: string;
  session?: string;
  interrupt?: true;
  conversation?: true;
  /** Its last line: what it last said, or its screen last showed; none before it showed any, or
   *  from a host older than Workspace API 0.35. */
  line?: string;
}

const asleep = (core: Core | null, tile: string): boolean => !!core?.tiles.find((t) => t.id === tile)?.sleeping;

/** The host's agents, as `hive ctl agents` prints them, each with its last line in `lines`. */
export function agentRows(items: readonly AgentItem[], core: Core | null, lines: Readonly<Record<string, string>> = {}): AgentRow[] {
  return items.map(({ workspace, name, tile, agent, program, state, ...rest }) => ({
    tile,
    name: agent,
    ...(program ? { agent: program.id } : {}),
    workspace: { id: workspace, name },
    ...rest,
    state: asleep(core, tile) ? "asleep" : state,
    ...(lines[tile] ? { line: lines[tile] } : {}),
  }));
}

/** One tile of the workspace, whatever it shows. */
export interface TileRow {
  tile: string;
  /** agent, terminal, tool, or the tile's own kind when none of those. */
  kind: string;
  name: string;
  /** The frame it is in; null when in none. */
  frame: string | null;
  /** An agent's state, as in `hive ctl agents`. A terminal has none; a tool's is its plugin's to say. */
  state?: string;
  /** The program an agent tile runs. */
  agent?: string;
  /** The plugin a tool tile is part of, and the tool, by their ids. */
  plugin?: string;
  tool?: string;
}

/** A tool tile's kind's plugin and tool; null for a kind no plugin here gives. */
export type ToolOf = (kind: string) => { plugin: string; tool: string } | null;

/** Every tile of `core`, in its order: agents with their state from `agents`, terminals, and tools
 *  with their plugin. */
export function tileRows(core: Core, agents: readonly AgentItem[], toolOf: ToolOf): TileRow[] {
  const listed = new Map(agents.map((a) => [a.tile, a]));
  const nameOf = (t: TileRecord): string => core.tileNames?.[t.id] || listed.get(t.id)?.agent || t.task || t.label;
  return core.tiles.map((t) => {
    const at = { tile: t.id, name: nameOf(t), frame: core.frameOf?.[t.id] ?? null };
    const listedAs = listed.get(t.id);
    const program = listedAs?.program?.id ?? agentForCmd(t.cmd)?.id;
    if (program) return { ...at, kind: "agent", agent: program, ...(t.sleeping ? { state: "asleep" } : listedAs ? { state: listedAs.state } : {}) };
    if (t.cmd !== undefined) return { ...at, kind: "terminal" };
    const tool = toolOf(t.kind);
    if (tool) return { ...at, kind: "tool", ...tool };
    return { ...at, kind: t.kind };
  });
}
