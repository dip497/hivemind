/**
 * The line a terminal's Layers row shows under its name (docs/design/last-line-2026-10-23.md §3):
 * what its agent waits on, in Signal Amber, else what its screen last showed. The row draws it
 * through `RowLine`, which listens to its own tile alone (line-store.ts, agent-waits.ts), so a line
 * that changes redraws that line: never the panel's model of the tiles, nor the row.
 */
import { memo, useCallback, useRef, useSyncExternalStore } from "react";
import { oneLine } from "@hivemind/agent-host/one-line";
import type { LayersPrefs } from "@hivemind/core/settings-schema";
import { subscribeWait, waitOf, type AgentWait, type TileWait } from "./agent-waits";
import { tileLines } from "./line-store";
import { decidable, DecideButtons, useCut } from "./wait-decide";
import { LOOKS } from "./workspace/status-look";

/** What a wait is, in a word, when it says no more. */
const KIND_WORDS: Record<AgentWait["kind"], string> = {
  permission: "Permission", question: "Question", plan: "Plan ready for review", approval: "Approval", other: "Blocked",
};

/**
 * What a row says under its name: for an agent that waits, the tool and the first line of what it
 * is about (`Bash: npm test`), its question (`Asks: …`), a plan to review, or else the kind of wait
 * in a word; for one that does not, its last line. "" for nothing. Each is what an agent or a process
 * in the tile wrote, so it is made one line of plain text (one-line.ts); React sets it as text,
 * never as markup.
 */
export function lineFor(waiting: AgentWait | undefined, line: string | undefined): string {
  if (!waiting) return oneLine(line ?? "");
  const tool = oneLine(waiting.tool?.name ?? "");
  const about = waiting.tool?.about?.split("\n").map(oneLine).find(Boolean);
  if (tool) return about ? `${tool}: ${about}` : tool;
  const asks = oneLine(waiting.asks?.[0]?.question ?? "");
  if (asks) return `Asks: ${asks}`;
  return KIND_WORDS[waiting.kind] ?? KIND_WORDS.other;
}

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
      {decides && <DecideButtons tile={tileId} waiting={waiting} cut={cut} className="mt-1.5" />}
    </>
  );
});

/** The whole of a terminal's line, for its row's hover card: what its agent waits on, the tool and
 *  all of what it would run (a few lines of it), else its last line, wrapped and never cut. */
export function CardLine({ tileId }: { tileId: string }) {
  const agent = useWait(tileId);
  const line = useLine(tileId);
  const waiting = agent?.waiting;
  const about = waiting?.tool?.about?.split("\n").map(oneLine).join("\n").trim();
  const text = about ? `${oneLine(waiting!.tool!.name)}: ${about}` : lineFor(waiting, line);
  if (!text) return null;
  return (
    <p data-layers-card-line={waiting ? "waiting" : "line"} className={`mt-3 line-clamp-6 whitespace-pre-wrap break-words font-mono text-count leading-4 ${waiting ? "" : "text-[var(--color-fg2)]"}`}
      style={waiting ? { color: LOOKS.needs.color } : undefined}>
      {text}
    </p>
  );
}
