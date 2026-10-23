import type { IssueState } from "./data";
import { nameHue } from "./name-hue";

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

/** A colour token (styles.css) in a name's own hue: the token says how light, for the page it is on. */
const inHue = (token: string, hue: number) => `oklch(from var(${token}) l c ${hue} / alpha)`;

export function LabelChip({ label }: { label: string }) {
  const hue = nameHue(label);
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-count font-medium"
      style={{
        color: inHue("--color-label-text", hue),
        background: inHue("--color-label-fill", hue),
        border: `1px solid ${inHue("--color-label-edge", hue)}`,
      }}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full"
        style={{ background: inHue("--color-label-dot", hue) }}
      />
      {label}
    </span>
  );
}

export function Avatar({ id, size = 18 }: { id: string; size?: number }) {
  const letter = id.slice(0, 1).toUpperCase();
  const hue = nameHue(id);
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-chip leading-none font-semibold shrink-0"
      style={{
        width: size,
        height: size,
        background: inHue("--color-person", hue),
        color: "var(--color-bg)",
      }}
      title={`@${id}`}
    >
      {letter}
    </span>
  );
}
