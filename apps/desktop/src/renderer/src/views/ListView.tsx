import { useState } from "react";
import type { IssueState, IssueSummary } from "@hivemind/core/types";
import { STATE_LABEL, STATE_ORDER, StateIcon, LabelChip, Avatar } from "../components/StateMeta";

interface Props {
  issues: IssueSummary[];
  onOpen: (id: string) => void;
  selectedId: string | null;
  showCancelled?: boolean;
}

export function ListView({ issues, onOpen, selectedId, showCancelled = false }: Props) {
  const [collapsed, setCollapsed] = useState<Set<IssueState>>(new Set());
  const groups = STATE_ORDER.filter((s) => showCancelled || s !== "cancelled");

  const toggle = (s: IssueState) => {
    const n = new Set(collapsed);
    n.has(s) ? n.delete(s) : n.add(s);
    setCollapsed(n);
  };

  return (
    <div className="h-full overflow-y-auto">
      {groups.map((state) => {
        const items = issues.filter((i) => i.state === state);
        if (items.length === 0) return null;
        const isCollapsed = collapsed.has(state);
        return (
          <section key={state}>
            <header
              onClick={() => toggle(state)}
              className="flex items-center gap-2 px-4 py-1.5 bg-[var(--color-bg2)] border-y border-[var(--color-line)] sticky top-0 z-10 cursor-pointer hover:bg-[var(--color-bg3)]"
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10"
                className={`text-[var(--color-fg3)] transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              >
                <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
              </svg>
              <StateIcon state={state} size={12} />
              <span className="text-[11.5px] font-semibold text-[var(--color-fg)]">{STATE_LABEL[state]}</span>
              <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums">{items.length}</span>
            </header>
            {!isCollapsed && (
              <ul>
                {items.map((i) => (
                  <Row key={i.id} issue={i} selected={selectedId === i.id} onOpen={onOpen} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {issues.length === 0 && (
        <div className="text-center py-20 text-[12px] text-[var(--color-fg3)]">
          No issues match these filters.
        </div>
      )}
    </div>
  );
}

function Row({
  issue: i,
  selected,
  onOpen,
}: {
  issue: IssueSummary;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`${i.id} — ${i.title}`}
      onClick={() => onOpen(i.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(i.id);
        }
      }}
      className={`flex items-center gap-3 px-4 py-1.5 border-b border-[var(--color-line)] cursor-pointer ${
        selected ? "bg-[var(--color-bg3)]" : "hover:bg-[var(--color-bg2)]"
      }`}
    >
      <StateIcon state={i.state} size={13} />
      <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums w-16 shrink-0">{i.id}</span>
      <span
        className={`text-[12.5px] flex-1 truncate ${
          i.state === "done"
            ? "text-[var(--color-fg3)] line-through decoration-1"
            : "text-[var(--color-fg)]"
        }`}
      >
        {i.title}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {i.labels.slice(0, 2).map((l) => (
          <LabelChip key={l} label={l} />
        ))}
        {i.labels.length > 2 && (
          <span className="text-[10px] text-[var(--color-fg3)]">+{i.labels.length - 2}</span>
        )}
      </div>
      {i.github != null && (
        <span className="font-mono text-[10px] text-[var(--color-info)] w-12 text-right shrink-0">#{i.github}</span>
      )}
      <span className="w-5 shrink-0 flex justify-end">
        {i.assignee ? <Avatar id={i.assignee.id} size={18} /> : null}
      </span>
    </li>
  );
}
