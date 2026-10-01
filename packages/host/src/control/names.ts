/**
 * What main calls a tile in the messages it types into agents (reports, approvals, pipe
 * forwards): what every surface calls it (`tileName`: the name someone gave it, else what its
 * agent says it is doing, else what it was started to do, else its label), cleaned to one
 * line and tagged with its id. A tile no open workspace holds is its bare id.
 */
import type { StatusStore } from "@hivemind/agent-host/status-store";
import { cleanName } from "@hivemind/agents";
import { tileName } from "@hivemind/workspace-doc/tile-list";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";

/** `reviewer (tile-claude-123)`, else the bare id. What banners print. */
export function labelOf(tileId: string, workspaces: Pick<WorkspaceStore, "workspaceOf" | "getCore">, status: Pick<StatusStore, "get">): string {
  const repo = workspaces.workspaceOf(tileId);
  const core = repo === null ? null : workspaces.getCore(repo);
  const tile = core?.tiles.find((t) => t.id === tileId);
  if (!core || !tile) return tileId;
  const title = status.get(tileId)?.title;
  // Typed into another agent's terminal: one clean line, whoever wrote it.
  const name = cleanName(tileName(core.tileNames ?? {}, title ? { [tileId]: title } : {}, tile));
  return name ? `${name} (${tileId})` : tileId;
}
