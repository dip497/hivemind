/**
 * What a tile's status looks like, on every surface that shows one: the slot bar, Layers, a
 * terminal's header and a frame's dot. Each look has a word, a colour and a shape, so no state is
 * told by colour alone, nor by a pulse that reduced motion stops. Layers, the headers and the
 * notifications all take their words from here.
 */
import type { Ref } from "react";
import type { TileStatusKind } from "../agent-status-bus";
import type { MachineState } from "../../../shared/ipc";
import { bucketTileStatus } from "@hivemind/view-host/status";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";

export type StatusLook = "working" | "needs" | "done" | "failed" | "idle" | "exited";

/** The word, mark and pulse come from the SDK's one table, which views draw from too; the colour is
 *  the app's own token for the tone. `color` paints a mark and a chip (its word on its own fill);
 *  `text` a word drawn straight on a header or a row, which the theme store fits to the lightest of
 *  them (`--color-status-*-text`). */
const look = (tone: keyof typeof STATUS_MARKS, color: string, text = color) => {
  const m = STATUS_MARKS[tone];
  return { word: m.word, color, text, shape: m.path, pulse: m.pulse };
};
export const LOOKS: Record<StatusLook, { word: string; color: string; text: string; shape: string; pulse: boolean }> = {
  working: look("working", "var(--color-status-working)"),
  needs: look("attention", "var(--color-status-attention)", "var(--color-status-attention-text)"),
  done: look("done", "var(--color-unread)", "var(--color-unread-text)"),
  failed: look("failed", "var(--color-status-failed)", "var(--color-status-failed-text)"),
  idle: look("idle", "var(--color-status-idle)"),
  exited: look("exited", "var(--color-status-exited)"),
};

/** A machine's link, as a mark and a word wherever a machine shows (its chip, Layers, the Machines
 *  hub, a terminal's banner): the same marks as a tile's status where the meaning is the same, so
 *  only signing in, the one state that waits on the person, is amber and pulses. `paused`: the
 *  person switched the machine off. */
export type MachineLook = MachineState | "paused";
const CIRCLE = STATUS_MARKS.working.path;
export const MACHINE_LOOKS: Record<MachineLook, { word: string; color: string; shape: string; pulse: boolean }> = {
  online: { word: "online", color: "var(--color-ok)", shape: CIRCLE, pulse: false },
  // A ring half filled: under way, its left half for a first connection and its right half again.
  connecting: { word: "connecting…", color: "var(--color-fg2)", shape: `${CIRCLE}M5 2a3 3 0 1 0 0 6a3 3 0 1 0 0-6ZM5 2a3 3 0 0 0 0 6Z`, pulse: false },
  reconnecting: { word: "reconnecting…", color: "var(--color-fg2)", shape: `${CIRCLE}M5 2a3 3 0 1 0 0 6a3 3 0 1 0 0-6ZM5 2a3 3 0 0 1 0 6Z`, pulse: false },
  // Away is ordinary (a laptop asleep, a box switched off): the exited square, not an alarm.
  offline: { word: "offline", color: "var(--color-fg3)", shape: STATUS_MARKS.exited.path, pulse: false },
  attention: { word: "sign in", color: LOOKS.needs.color, shape: LOOKS.needs.shape, pulse: true },
  // Connected, without hive to keep its sessions through a drop: a dot with a bar through it.
  "no-hive": { word: "no hive", color: "var(--color-fg2)", shape: `${CIRCLE}M2 4.2H8V5.8H2Z`, pulse: false },
  idle: { word: "idle", color: "var(--color-fg3)", shape: STATUS_MARKS.idle.path, pulse: false },
  paused: { word: "paused", color: "var(--color-fg3)", shape: "M2 1.5H4.2V8.5H2ZM5.8 1.5H8V8.5H5.8Z", pulse: false },
};

/** A machine's look: paused while the person has it switched off, else its link's state. */
export function machineLook(state: MachineState, enabled = true): MachineLook {
  return enabled ? state : "paused";
}

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

/** A machine look's mark, `size` pixels square. `named`: no word is shown beside it, so the mark
 *  carries its word for a screen reader and under the pointer. */
export function MachineGlyph({ look, size, named }: { look: MachineLook; size: number; named: boolean }) {
  const l = MACHINE_LOOKS[look];
  return (
    <svg viewBox="0 0 10 10" width={size} height={size} data-machine-look={look}
      {...(named ? { role: "img", "aria-label": l.word } : { "aria-hidden": true })}
      className={`shrink-0 ${l.pulse ? "animate-pulse" : ""}`} style={{ color: l.color }}>
      {named && <title>{l.word}</title>}
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
