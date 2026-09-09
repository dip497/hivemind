/**
 * Which editor tile should receive a file the user opened from somewhere else
 * (a path clicked in a terminal, "reveal in editor")?
 *
 * Frame-scoped: a file opened from a tile in frame A belongs in frame A's
 * editor, never in another repo's. A workbench counts as an editor (it embeds
 * one). `null` means "no editor here" — the caller spawns one AND hands it the
 * path, which is the case that used to silently drop the file.
 */
import type { TileInstance } from "../canvas-persistence";

const EDITOR_KINDS = new Set(["editor", "workbench"]);

export function pickEditorTile(
  tiles: readonly TileInstance[],
  frameOf: Readonly<Record<string, string>>,
  frameId: string | null,
): string | null {
  const hit = tiles.find((t) => EDITOR_KINDS.has(t.kind) && (!frameId || frameOf[t.id] === frameId));
  return hit?.id ?? null;
}
