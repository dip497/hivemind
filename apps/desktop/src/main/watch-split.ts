/**
 * A window's watch of tiles (`tile.watchLines`, `terminal.watchActivity`) or one-shot read of them
 * (`tile.readLines`) names every tile it shows, of this host's workspaces and of those shared with
 * it from elsewhere together (M1). Each workspace's host is asked of its own tiles alone, each a
 * watch of the window's own in place of the last one (`[]` for a host whose tiles it shows no more),
 * and what they answer is put together. Electron-free.
 */
import type { Answer } from "@hivemind/workspace-api/protocol";
import type { LastLines } from "@hivemind/workspace-api/terminals";
import { toBareId } from "@hivemind/workspace-api/tile-id";

/** The methods whose first param is a list of tiles, split between hosts. */
export const SPLIT_METHODS: ReadonlySet<string> = new Set(["tile.watchLines", "tile.readLines", "terminal.watchActivity"]);
/** Of those, the ones that replace what the window watched before. */
export const WATCHES: ReadonlySet<string> = new Set(["tile.watchLines", "terminal.watchActivity"]);

/** `tiles`, by the workspace shared from elsewhere each is of (`hostOf`, null: this host's). */
export function splitTiles(tiles: readonly unknown[], hostOf: (bare: string) => string | null): { here: unknown[]; there: Map<string, string[]> } {
  const here: unknown[] = [];
  const there = new Map<string, string[]>();
  for (const tile of tiles) {
    const workspace = typeof tile === "string" ? hostOf(toBareId(tile)) : null;
    if (!workspace) { here.push(tile); continue; }
    let mine = there.get(workspace);
    if (!mine) there.set(workspace, (mine = []));
    mine.push(tile as string);
  }
  return { here, there };
}

/** The lines each host answered, together: a host that failed (one older than 0.34) gives none.
 *  The first answer that failed is the answer when none gave lines and this host failed too. */
export function joinLines(answers: readonly Answer[]): Answer {
  const lines: LastLines = {};
  let any = false;
  for (const a of answers) {
    if ("error" in a) continue;
    any = true;
    Object.assign(lines, (a.result as { lines?: LastLines } | null)?.lines ?? {});
  }
  return any ? { result: { lines } } : answers[0]!;
}
