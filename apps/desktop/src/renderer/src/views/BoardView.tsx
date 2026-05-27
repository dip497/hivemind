import { useState } from "react";
import type { IssueState, IssueSummary } from "@hivemind/core/types";
import { STATE_LABEL, STATE_ORDER, StateIcon, LabelChip, Avatar } from "../components/StateMeta";
import { useUpdateState } from "../queries";

interface Props {
  root: string | null;
  issues: IssueSummary[];
  onOpen: (id: string) => void;
  selectedId: string | null;
  showCancelled?: boolean;
}

export function BoardView({ root, issues, onOpen, selectedId, showCancelled = false }: Props) {
  const update = useUpdateState();
  const [dragOver, setDragOver] = useState<IssueState | null>(null);
  const columns = STATE_ORDER.filter((s) => showCancelled || s !== "cancelled");

  const handleDrop = (state: IssueState, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    if (!id || !root) return;
    const issue = issues.find((i) => i.id === id);
    if (!issue || issue.state === state) return;
    update.mutate({ root, id, state, note: `moved to ${state} via board` });
  };

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden">
      <div className="h-full flex gap-3 px-4 py-3 min-w-fit">
        {columns.map((state) => {
          const items = issues.filter((i) => i.state === state);
          const isOver = dragOver === state;
          return (
            <div
              key={state}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(state); }}
              onDragLeave={() => setDragOver((s) => (s === state ? null : s))}
              onDrop={(e) => handleDrop(state, e)}
              className={`w-[280px] shrink-0 flex flex-col rounded-md transition-colors ${
                isOver
                  ? "bg-[var(--color-bg3)] outline outline-2 outline-[var(--color-brand)]"
                  : "bg-transparent"
              }`}
            >
              <div className="flex items-center gap-2 px-2 py-2">
                <StateIcon state={state} size={13} />
                <span className="text-[12px] font-semibold text-[var(--color-fg)]">{STATE_LABEL[state]}</span>
                <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums ml-1">
                  {items.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto px-1 pb-2 space-y-1.5">
                {items.length === 0 ? (
                  <div className="text-center text-[11px] text-[var(--color-fg3)] py-6 border border-dashed border-[var(--color-line2)] rounded">
                    Drop here
                  </div>
                ) : (
                  items.map((i) => (
                    <Card key={i.id} issue={i} selected={selectedId === i.id} onOpen={onOpen} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({
  issue: i,
  selected,
  onOpen,
}: {
  issue: IssueSummary;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${i.id} — ${i.title}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", i.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => onOpen(i.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(i.id);
        }
      }}
      className={`group rounded-md border p-2 cursor-pointer transition-all text-left ${
        dragging ? "opacity-40 scale-[0.98] shadow-lg" : ""
      } ${
        selected
          ? "bg-[var(--color-bg4)] border-[var(--color-brand)]"
          : "bg-[var(--color-bg3)] border-[var(--color-line2)] hover:border-[var(--color-fg3)]"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] text-[var(--color-fg3)] tabular-nums">{i.id}</span>
        {i.github != null && (
          <a
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[10px] text-[var(--color-info)] hover:underline"
          >
            #{i.github}
          </a>
        )}
      </div>
      <div className="text-[12.5px] text-[var(--color-fg)] leading-snug mt-1 line-clamp-2">{i.title}</div>
      {(i.labels.length > 0 || i.assignee) && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {i.labels.slice(0, 3).map((l) => (
            <LabelChip key={l} label={l} />
          ))}
          {i.labels.length > 3 && (
            <span className="text-[10px] text-[var(--color-fg3)]">+{i.labels.length - 3}</span>
          )}
          {i.assignee && <span className="ml-auto"><Avatar id={i.assignee.id} size={16} /></span>}
        </div>
      )}
    </div>
  );
}
