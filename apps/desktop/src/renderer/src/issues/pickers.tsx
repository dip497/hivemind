import { useState } from "react";
import type { Assignee, IssueSummary } from "@hivemind/core/types";
import { Avatar, LabelChip } from "../components/StateMeta";
import { Popover } from "../components/ui/popover";

const INPUT =
  "w-full px-2 py-1 text-[12px] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md outline-none focus:border-[var(--color-brand)] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)]";

const Check = () => (
  <svg width="9" height="9" viewBox="0 0 10 10">
    <path d="M2 5.2L4.2 7.2L8 3" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function AssigneePicker({
  value,
  allAssignees,
  onChange,
}: {
  value: Assignee | null;
  allAssignees: string[];
  onChange: (a: Assignee | null) => void;
}) {
  const [q, setQ] = useState("");
  return (
    <Popover
      width={200}
      trigger={
        value ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg)] hover:text-[var(--color-accent)]">
            <Avatar id={value.id} size={18} />
            {value.id}
          </span>
        ) : (
          <span className="text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)]">Unassigned</span>
        )
      }
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="assign to…" className={INPUT} />
          <div className="max-h-40 overflow-y-auto">
            {value && (
              <button
                onClick={() => { onChange(null); close(); }}
                className="w-full text-left px-2 py-1 text-[11.5px] text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] rounded cursor-pointer"
              >
                Unassign
              </button>
            )}
            {allAssignees
              .filter((a) => a.toLowerCase().includes(q.toLowerCase()))
              .map((a) => (
                <button
                  key={a}
                  onClick={() => { onChange({ type: "member", id: a }); close(); }}
                  className="w-full flex items-center gap-1.5 px-2 py-1 text-[12px] text-left hover:bg-[var(--color-bg4)] rounded text-[var(--color-fg)] cursor-pointer"
                >
                  <Avatar id={a} size={16} />
                  {a}
                </button>
              ))}
            {q.trim() && !allAssignees.includes(q.trim()) && (
              <button
                onClick={() => { onChange({ type: "member", id: q.trim() }); close(); }}
                className="w-full text-left px-2 py-1 text-[12px] hover:bg-[var(--color-bg4)] rounded text-[var(--color-accent)] cursor-pointer"
              >
                Assign “{q.trim()}”
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

export function LabelPicker({
  value,
  allLabels,
  onChange,
}: {
  value: string[];
  allLabels: string[];
  onChange: (l: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const toggle = (l: string) => onChange(value.includes(l) ? value.filter((x) => x !== l) : [...value, l]);
  return (
    <Popover
      width={210}
      trigger={
        value.length ? (
          <div className="flex flex-wrap gap-1">
            {value.map((l) => (
              <LabelChip key={l} label={l} />
            ))}
          </div>
        ) : (
          <span className="text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)]">Add labels…</span>
        )
      }
    >
      {() => (
        <div className="flex flex-col gap-1">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter / add…"
            className={INPUT}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim()) {
                if (!value.includes(q.trim())) onChange([...value, q.trim()]);
                setQ("");
              }
            }}
          />
          <div className="max-h-40 overflow-y-auto">
            {allLabels
              .filter((l) => l.toLowerCase().includes(q.toLowerCase()))
              .map((l) => (
                <button
                  key={l}
                  onClick={() => toggle(l)}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-[var(--color-bg4)] rounded cursor-pointer"
                >
                  <span
                    className="size-3 rounded-sm border flex items-center justify-center shrink-0"
                    style={{
                      background: value.includes(l) ? "var(--color-brand)" : "transparent",
                      borderColor: value.includes(l) ? "var(--color-brand)" : "var(--color-line2)",
                    }}
                  >
                    {value.includes(l) && <Check />}
                  </span>
                  <LabelChip label={l} />
                </button>
              ))}
            {q.trim() && !allLabels.includes(q.trim()) && (
              <button
                onClick={() => { onChange([...value, q.trim()]); setQ(""); }}
                className="w-full text-left px-2 py-1 text-[12px] hover:bg-[var(--color-bg4)] rounded text-[var(--color-accent)] cursor-pointer"
              >
                Create “{q.trim()}”
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

export function ParentPicker({
  value,
  candidates,
  onChange,
}: {
  value: string | null;
  candidates: IssueSummary[];
  onChange: (p: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const matches = candidates
    .filter((i) => i.id.toLowerCase().includes(q.toLowerCase()) || i.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 25);
  return (
    <Popover
      width={250}
      trigger={
        value ? (
          <span className="font-mono text-[11px] text-[var(--color-fg)] hover:text-[var(--color-accent)]">{value}</span>
        ) : (
          <span className="text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)]">Set parent…</span>
        )
      }
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="search issues…" className={INPUT} />
          <div className="max-h-48 overflow-y-auto">
            {value && (
              <button
                onClick={() => { onChange(null); close(); }}
                className="w-full text-left px-2 py-1 text-[11.5px] text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] rounded cursor-pointer"
              >
                Clear parent
              </button>
            )}
            {matches.map((i) => (
              <button
                key={i.id}
                onClick={() => { onChange(i.id); close(); }}
                className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-[var(--color-bg4)] rounded cursor-pointer"
              >
                <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums shrink-0">{i.id}</span>
                <span className="text-[12px] text-[var(--color-fg)] truncate">{i.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
