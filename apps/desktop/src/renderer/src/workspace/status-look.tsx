/**
 * What a tile's status looks like, on every surface that shows one: the slot bar, Layers, a
 * terminal's header and a frame's dot. Each look has a word, a colour and a shape, so no state is
 * told by colour alone, nor by a pulse that reduced motion stops. Layers, the headers and the
 * notifications all take their words from here.
 */
import type { Ref } from "react";
import type { TileStatusKind } from "../agent-status-bus";
import { bucketTileStatus } from "@hivemind/view-host/status";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";

export type StatusLook = "working" | "needs" | "done" | "failed" | "idle" | "exited";

/** The word, mark and pulse come from the SDK's one table, which views draw from too; the colour is
 *  the app's own token for the tone. */
const look = (tone: keyof typeof STATUS_MARKS, color: string) => {
  const m = STATUS_MARKS[tone];
  return { word: m.word, color, shape: m.path, pulse: m.pulse };
};
export const LOOKS: Record<StatusLook, { word: string; color: string; shape: string; pulse: boolean }> = {
  working: look("working", "var(--color-status-working)"),
  needs: look("attention", "var(--color-status-attention)"),
  done: look("done", "var(--color-unread)"),
  failed: look("failed", "var(--color-status-failed)"),
  idle: look("idle", "var(--color-status-idle)"),
  exited: look("exited", "var(--color-status-exited)"),
};

/** What a tile that needs you waits for, in a word. */
const WAITS: Partial<Record<TileStatusKind, string>> = {
  permission: "approve?", question: "input?", plan_review: "review?", awaiting_approval: "approval?", blocked: "blocked",
};

/** An exit failed when its process said so (a non-zero code), or it never ran (`failed`); a close
 *  or `/exit` is a clean one. */
export function exitFailed(e: { status: TileStatusKind; exitCode?: number; failed?: boolean }): boolean {
  return e.status === "exited" && (!!e.exitCode || !!e.failed);
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
