/**
 * The line slots a view reserves (`lineRects`, protocol 1.17, docs/design/last-line-2026-10-23.md
 * §4): in each, the host draws the tile's last line, or what its agent waits on in Signal Amber with
 * the host's own Deny and Allow when it can be answered (wait-decide.tsx). The view gets the room
 * and never the text: what an agent or a terminal wrote stays on this side of the frame.
 *
 * A slot lets the pointer through to the view, but its buttons take it; it is kept inside the
 * view's box, and its buttons inside the slot.
 */
import { memo, useRef } from "react";
import type { LineRect } from "@hivemind/view-sdk/protocol";
import { lineFor, useLine, useWait } from "../../../row-line";
import { decidable, DecideButtons, useCut } from "../../../wait-decide";
import { LOOKS } from "../../status-look";

/** Below this a slot's buttons are 20px, not 28px. */
const ROOMY_H = 28;

export function LineSlots({ rects, box }: { rects: LineRect[]; box: { w: number; h: number } }) {
  if (!rects.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-community-lines>
      {rects.map((r) => {
        const x = Math.max(0, Math.min(r.x, box.w)), y = Math.max(0, Math.min(r.y, box.h));
        const w = Math.max(0, Math.min(r.w, box.w - x)), h = Math.max(0, Math.min(r.h, box.h - y));
        return w > 0 && h > 0 ? <LineSlot key={r.tileId} tileId={r.tileId} x={x} y={y} w={w} h={h} /> : null;
      })}
    </div>
  );
}

const LineSlot = memo(function LineSlot({ tileId, x, y, w, h }: { tileId: string; x: number; y: number; w: number; h: number }) {
  const agent = useWait(tileId);
  const line = useLine(tileId);
  const waiting = agent?.waiting;
  const text = lineFor(waiting, line);
  const decides = decidable(waiting);
  const el = useRef<HTMLSpanElement>(null);
  const cut = useCut(el, text, decides);
  return (
    <div className="absolute flex items-center gap-2 overflow-hidden" style={{ left: x, top: y, width: w, height: h }} data-community-line={tileId}>
      <span ref={el} data-line-slot={waiting ? "waiting" : "line"} className={`min-w-0 flex-1 truncate font-mono text-count leading-4 ${waiting ? "" : "text-[var(--color-fg2)]"}`}
        style={waiting ? { color: LOOKS.needs.color } : undefined}>
        {text}
      </span>
      {decides && <DecideButtons tile={tileId} waiting={waiting} cut={cut} small={h < ROOMY_H} className="pointer-events-auto shrink-0" />}
    </div>
  );
});
