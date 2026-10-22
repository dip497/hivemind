/**
 * What a tile's status looks like, on every surface that shows one: the slot bar, Layers, a
 * terminal's header and a frame's dot. Each look has a word, a colour and a shape, so no state is
 * told by colour alone, nor by a pulse that reduced motion stops. Layers, the headers and the
 * notifications all take their words from here.
 */
import type { Ref } from "react";
import type { TileStatusKind } from "../agent-status-bus";
import { bucketTileStatus } from "@hivemind/view-host/status";

export type StatusLook = "working" | "needs" | "done" | "failed" | "idle" | "exited";

/** Shapes in a 10×10 box, filled with the look's colour. */
const CIRCLE = "M5 0.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9Z";
const RING = `${CIRCLE}M5 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z`;
const TRIANGLE = "M5 0.5L9.8 9.3H0.2Z";
const DIAMOND = "M5 0L10 5L5 10L0 5Z";
const SQUARE = "M1 1H9V9H1Z";
const CROSS = "M2.2 0.8L5 3.6L7.8 0.8L9.2 2.2L6.4 5L9.2 7.8L7.8 9.2L5 6.4L2.2 9.2L0.8 7.8L3.6 5L0.8 2.2Z";

export const LOOKS: Record<StatusLook, { word: string; color: string; shape: string; pulse: boolean }> = {
  working: { word: "working", color: "var(--color-status-working)", shape: CIRCLE, pulse: false },
  // The one look that asks for you: it alone pulses.
  needs: { word: "needs you", color: "var(--color-status-attention)", shape: TRIANGLE, pulse: true },
  // Finished since you last looked.
  done: { word: "finished", color: "var(--color-unread)", shape: DIAMOND, pulse: false },
  failed: { word: "failed", color: "var(--color-status-failed)", shape: CROSS, pulse: false },
  idle: { word: "idle", color: "var(--color-status-idle)", shape: RING, pulse: false },
  exited: { word: "exited", color: "var(--color-status-exited)", shape: SQUARE, pulse: false },
};

/** What a tile that needs you waits for, in a word. */
const WAITS: Partial<Record<TileStatusKind, string>> = {
  permission: "approve?", question: "input?", plan_review: "review?", awaiting_approval: "approval?", blocked: "blocked",
};

/** An exit failed when its process said so (a non-zero code); a close or `/exit` is a clean one. */
export function exitFailed(e: { status: TileStatusKind; exitCode?: number }): boolean {
  return e.status === "exited" && !!e.exitCode;
}

/** A status's look. `unread`: it finished since the person last looked. */
export function statusLook(s: TileStatusKind | null, how: { failed?: boolean; unread?: boolean } = {}): StatusLook {
  switch (bucketTileStatus(s)) {
    case "working": return "working";
    case "blocked": return "needs";
    case "exited": return how.failed ? "failed" : "exited";
    default: return how.unread ? "done" : "idle";
  }
}

/** The word a tile's own chip says: what it waits for when it needs you, else its look's word. */
export function statusWord(s: TileStatusKind | null, how: { failed?: boolean } = {}): string {
  return (s && WAITS[s]) ?? LOOKS[statusLook(s, how)].word;
}

/** The look a group of tiles shows for all of them: one that needs you, else one that failed, else
 *  one at work. Null: nothing in it is worth a mark. */
export function groupLook(looks: Iterable<StatusLook>): "needs" | "failed" | "working" | null {
  let best: "needs" | "failed" | "working" | null = null;
  for (const l of looks) {
    if (l === "needs") return l;
    if (l === "failed" || (l === "working" && !best)) best = l;
  }
  return best;
}

/** A look's mark, at the size `className` gives it (the dots it replaced: size-1.5, size-2). */
export function StatusGlyph({ look, className = "size-2", ref }: { look: StatusLook; className?: string; ref?: Ref<SVGSVGElement> }) {
  const l = LOOKS[look];
  return (
    <svg ref={ref} viewBox="0 0 10 10" aria-hidden data-status-look={look} className={`shrink-0 ${l.pulse ? "animate-pulse" : ""} ${className}`} style={{ color: l.color }}>
      <path d={l.shape} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** Repaint a mark `StatusGlyph` drew, for a header that paints its chip without a render. */
export function paintGlyph(svg: SVGSVGElement, look: StatusLook): void {
  const l = LOOKS[look];
  svg.dataset.statusLook = look;
  svg.style.color = l.color;
  svg.classList.toggle("animate-pulse", l.pulse);
  svg.firstElementChild?.setAttribute("d", l.shape);
}
