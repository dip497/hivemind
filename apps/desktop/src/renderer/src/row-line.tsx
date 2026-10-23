/**
 * The line a terminal's Layers row shows under its name (docs/design/last-line-2026-10-23.md §3):
 * what its agent waits on, in Signal Amber, else what its screen last showed. The row draws it
 * through `RowLine`, which listens to its own tile alone (line-store.ts, agent-waits.ts), so a line
 * that changes redraws that line: never the panel's model of the tiles, nor the row.
 */
import { memo, useCallback, useSyncExternalStore } from "react";
import type { LayersPrefs } from "@hivemind/core/settings-schema";
import { subscribeWait, waitOf, type TileWait } from "./agent-waits";
import { lineFor } from "../../shared/line-for";
import { tileLines } from "./line-store";
import { LOOKS } from "./workspace/status-look";

export { lineFor };

/** `tile`'s line as main tells it; the tile is watched while this asks for it (not null). */
function useLine(tile: string | null): string | undefined {
  const subscribe = useCallback((l: () => void) => (tile ? tileLines.subscribe(tile, l) : () => {}), [tile]);
  return useSyncExternalStore(subscribe, () => (tile ? tileLines.get(tile) : undefined));
}

/** `tile`'s agent as the feed tells it, while this asks for it (not null). */
function useWait(tile: string | null): TileWait | undefined {
  const subscribe = useCallback((l: () => void) => (tile ? subscribeWait(tile, l) : () => {}), [tile]);
  return useSyncExternalStore(subscribe, () => (tile ? waitOf(tile) : undefined));
}

/** The id of `tile`'s line, which its row is described by. */
export const lineId = (tile: string) => `layer-line-${tile}`;

/** The second line of a terminal's row, as the View menu's Lines says (`show`): nothing at all
 *  when there is nothing to say, so the row stays one line high. An agent that keeps a conversation
 *  shows only what it waits on: the last line of its screen is its own chrome. */
export const RowLine = memo(function RowLine({ tileId, show }: { tileId: string; show: LayersPrefs["lines"] }) {
  const agent = useWait(show === "off" ? null : tileId);
  const line = useLine(show === "all" && !agent?.converses ? tileId : null);
  const text = lineFor(agent?.waiting, line);
  if (!text) return null;
  const waits = !!agent?.waiting;
  return (
    <span id={lineId(tileId)} data-layer-line={waits ? "waiting" : "line"} className={`truncate font-mono text-count leading-4 ${waits ? "" : "text-[var(--color-fg2)]"}`}
      style={waits ? { color: LOOKS.needs.color } : undefined}>
      {text}
    </span>
  );
});
