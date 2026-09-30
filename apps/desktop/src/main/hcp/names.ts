/**
 * What main calls a tile in the messages it types into agents (reports, approvals, pipe
 * forwards): the same name every surface shows — a name someone gave it, else what its agent
 * says it is doing — tagged with its id, or the bare id when it has neither.
 *
 * Given names come from the renderer, which owns and persists them; a spawner's name is known
 * here first, before the renderer has stored it.
 */

/** bare tileId → the name someone gave it. */
let names = new Map<string, string>();
let titleOf: (tileId: string) => string | undefined = () => undefined;

/** The renderer's names, whole, each time they change. */
export function setNames(all: Record<string, string>): void {
  names = new Map(Object.entries(all));
}

export function setName(tileId: string, name: string | null): void {
  if (name) names.set(tileId, name);
  else names.delete(tileId);
}

/** Where agent titles come from (the status store). */
export function setTitleSource(fn: (tileId: string) => string | undefined): void {
  titleOf = fn;
}

/** `"reviewer" (tile-claude-123)`, else the bare id. What banners print. */
export function labelOf(tileId: string): string {
  const n = names.get(tileId) ?? titleOf(tileId);
  return n ? `${n} (${tileId})` : tileId;
}
