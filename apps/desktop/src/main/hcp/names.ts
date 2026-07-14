/**
 * Display names for HCP-spawned workers.
 *
 * A spawner passes `name` to `tile.spawn_agent` ("reviewer", "test-writer"); the
 * renderer uses it as the tile label, and every message the worker sends back —
 * the auto-report pipe forward, an explicit `agent.report`, an approval request —
 * is tagged with it instead of the opaque `tile-claude-1763...` id.
 *
 * Lives in its own module because BOTH methods.ts (which learns the name at spawn)
 * and index.ts (which formats the pipe-forward banner) need it.
 */

/** bare tileId → display name, for HCP-spawned workers that were given one. */
const names = new Map<string, string>();

export function setName(tileId: string, name: string | null): void {
  if (name) names.set(tileId, name);
  else names.delete(tileId);
}

/** `"reviewer" (tile-claude-123)` when named, else the bare id. What banners print. */
export function labelOf(tileId: string): string {
  const n = names.get(tileId);
  return n ? `${n} (${tileId})` : tileId;
}
