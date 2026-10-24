/**
 * The line a terminal's Layers row shows under its name (docs/design/last-line-2026-10-23.md §3):
 * what its agent waits on, in Signal Amber, else what its screen last showed. The row draws it
 * through `RowLine`, which listens to its own tile alone (line-store.ts, agent-waits.ts), so a line
 * that changes redraws that line: never the panel's model of the tiles, nor the row.
 */
import { memo, useCallback, useRef, useSyncExternalStore } from "react";
import { oneLine } from "@hivemind/agent-host/one-line";
import type { LayersPrefs } from "@hivemind/core/settings-schema";
import { subscribeWait, waitOf, type TileWait } from "./agent-waits";
import { lineFor } from "../../shared/line-for";
import { tileLines } from "./line-store";
import { decidable, DecideButtons, REVIEW_MAX, reviewText, useCut } from "./wait-decide";
import { LOOKS } from "./workspace/status-look";

/** `tile`'s line as main tells it; the tile is watched while this asks for it (not null). */
export function useLine(tile: string | null): string | undefined {
  const subscribe = useCallback((l: () => void) => (tile ? tileLines.subscribe(tile, l) : () => {}), [tile]);
  return useSyncExternalStore(subscribe, () => (tile ? tileLines.get(tile) : undefined));
}

/** `tile`'s agent as the feed tells it, while this asks for it (not null). */
export function useWait(tile: string | null): TileWait | undefined {
  const subscribe = useCallback((l: () => void) => (tile ? subscribeWait(tile, l) : () => {}), [tile]);
  return useSyncExternalStore(subscribe, () => (tile ? waitOf(tile) : undefined));
}

/** The id of `tile`'s line, which its row is described by. */
export const lineId = (tile: string) => `layer-line-${tile}`;

/** The second line of a terminal's row, as the View menu's Lines says (`show`): nothing at all
 *  when there is nothing to say, so the row stays one line high. For an agent that keeps a
 *  conversation main's line is what it last said there, never its screen's chrome. A permission
 *  that can be answered from here adds a band of Deny and Allow under it (wait-decide.tsx). */
export const RowLine = memo(function RowLine({ tileId, show }: { tileId: string; show: LayersPrefs["lines"] }) {
  const agent = useWait(show === "off" ? null : tileId);
  const line = useLine(show === "all" ? tileId : null);
  const text = lineFor(agent?.waiting, line);
  const waiting = agent?.waiting;
  const decides = decidable(waiting);
  const el = useRef<HTMLSpanElement>(null);
  const cut = useCut(el, text, decides);
  if (!text) return null;
  return (
    <>
      <span ref={el} id={lineId(tileId)} data-layer-line={waiting ? "waiting" : "line"} className={`truncate font-mono text-count leading-4 ${waiting ? "" : "text-[var(--color-fg2)]"}`}
        style={waiting ? { color: LOOKS.needs.color } : undefined}>
        {text}
      </span>
      {/* The ghost button's text, not its box, lines up with the line above. */}
      {decides && <DecideButtons tile={tileId} waiting={waiting} cut={cut} className="mt-1.5 -ml-2.5" />}
    </>
  );
});

/** The whole of a terminal's line, for its row's hover card: what its agent waits on, the tool and
 *  what it would run as the agent wrote it (its lines kept, none cut, controls out; its first twelve
 *  lines, ending in an ellipsis when there are more, and saying when it may be longer than a review
 *  shows), else its last line, wrapped and never cut. Review is where all of it is read. */
export function CardLine({ tileId }: { tileId: string }) {
  const agent = useWait(tileId);
  const line = useLine(tileId);
  const waiting = agent?.waiting;
  const about = waiting?.tool?.about ? reviewText(waiting.tool.about) : null;
  const text = about?.text ? `${oneLine(waiting!.tool!.name)}: ${about.text}` : lineFor(waiting, line);
  if (!text) return null;
  return (
    <>
      <p data-layers-card-line={waiting ? "waiting" : "line"} className={`mt-3 line-clamp-12 whitespace-pre-wrap break-all font-mono text-count leading-4 ${waiting ? "" : "text-[var(--color-fg2)]"}`}
        style={waiting ? { color: LOOKS.needs.color } : undefined}>
        {text}
      </p>
      {about?.more && <p className="mt-1 text-count text-[var(--color-fg3)]">Only its first {REVIEW_MAX.toLocaleString()} characters are shown.</p>}
    </>
  );
}
