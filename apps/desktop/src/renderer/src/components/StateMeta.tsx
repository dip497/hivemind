import type { IssueState } from "@hivemind/core/types";

export const STATE_COLOR: Record<IssueState, string> = {
  backlog: "var(--color-state-backlog)",
  todo: "var(--color-state-todo)",
  in_progress: "var(--color-state-progress)",
  in_review: "var(--color-state-review)",
  done: "var(--color-state-done)",
  cancelled: "var(--color-state-cancelled)",
};

export const STATE_LABEL: Record<IssueState, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATE_GROUP: Record<IssueState, "backlog" | "unstarted" | "started" | "completed" | "cancelled"> = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  done: "completed",
  cancelled: "cancelled",
};

export const STATE_ORDER: IssueState[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];

export function StateDot({ state, pulse = false, size = 8 }: { state: IssueState; pulse?: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      className={`inline-block rounded-full shrink-0 ${pulse ? "animate-pulse" : ""}`}
      style={{ width: size, height: size, background: STATE_COLOR[state] }}
    />
  );
}

/** Plane-style ring icon — hollow for not-started, half for in-progress/review, filled for done */
export function StateIcon({ state, size = 14 }: { state: IssueState; size?: number }) {
  const color = STATE_COLOR[state];
  const group = STATE_GROUP[state];
  if (group === "completed") {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0">
        <circle cx="7" cy="7" r="6" fill={color} />
        <path d="M4 7.2L6 9.2L10 5" stroke="var(--color-bg)" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (group === "cancelled") {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0">
        <circle cx="7" cy="7" r="6" fill={color} />
        <path d="M4.5 4.5L9.5 9.5M9.5 4.5L4.5 9.5" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (group === "started") {
    const fillPct = state === "in_review" ? 0.85 : 0.6;
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" />
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${fillPct * 34.5} 34.5`} transform="rotate(-90 7 7)" />
      </svg>
    );
  }
  if (group === "unstarted") {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    );
  }
  // backlog
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  );
}

export function StateChip({ state }: { state: IssueState }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10.5px] font-medium border"
      style={{
        color: STATE_COLOR[state],
        background: `color-mix(in oklab, ${STATE_COLOR[state]} 14%, transparent)`,
        borderColor: `color-mix(in oklab, ${STATE_COLOR[state]} 24%, transparent)`,
      }}
    >
      <StateIcon state={state} size={11} />
      {STATE_LABEL[state]}
    </span>
  );
}

export function LabelChip({ label }: { label: string }) {
  const hue = Array.from(label).reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium"
      style={{
        color: `oklch(0.82 0.10 ${hue})`,
        background: `oklch(0.28 0.04 ${hue} / 0.5)`,
        border: `1px solid oklch(${hue === 0 ? 0.34 : 0.34} 0.03 ${hue} / 0.4)`,
      }}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full"
        style={{ background: `oklch(0.72 0.15 ${hue})` }}
      />
      {label}
    </span>
  );
}

export function Avatar({ id, size = 18 }: { id: string; size?: number }) {
  const letter = id.slice(0, 1).toUpperCase();
  const hue = Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: `oklch(0.78 0.13 ${hue})`,
        color: "var(--color-bg)",
      }}
      title={`@${id}`}
    >
      {letter}
    </span>
  );
}
