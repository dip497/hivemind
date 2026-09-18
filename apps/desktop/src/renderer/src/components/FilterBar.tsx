import { useMemo, useState } from "react";
import type { IssueState, IssueSummary } from "@hivemind/core/types";
import { STATE_LABEL, STATE_ORDER, StateIcon, LabelChip, Avatar } from "./StateMeta";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { MenuItem } from "./ui/menu-item";
import { Popover } from "./ui/popover";

export interface Filters {
  q: string;
  states: Set<IssueState>;
  labels: Set<string>;
  assignees: Set<string>;
  /** When true, BoardView/ListView render the Cancelled column/group. */
  showCancelled: boolean;
}

export const emptyFilters = (): Filters => ({
  q: "",
  states: new Set(),
  labels: new Set(),
  assignees: new Set(),
  showCancelled: false,
});

export function applyFilters(issues: IssueSummary[], f: Filters): IssueSummary[] {
  const q = f.q.trim().toLowerCase();
  return issues.filter((i) => {
    if (f.states.size > 0 && !f.states.has(i.state)) return false;
    if (f.labels.size > 0 && !i.labels.some((l) => f.labels.has(l))) return false;
    if (f.assignees.size > 0 && !(i.assignee && f.assignees.has(i.assignee.id))) return false;
    if (q && !i.title.toLowerCase().includes(q) && !i.id.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function FilterBar({
  issues,
  filters,
  onChange,
  rightSlot,
}: {
  issues: IssueSummary[];
  filters: Filters;
  onChange: (f: Filters) => void;
  rightSlot?: React.ReactNode;
}) {
  const allLabels = useMemo(() => {
    const s = new Set<string>();
    issues.forEach((i) => i.labels.forEach((l) => s.add(l)));
    return Array.from(s).sort();
  }, [issues]);
  const allAssignees = useMemo(() => {
    const s = new Set<string>();
    issues.forEach((i) => i.assignee && s.add(i.assignee.id));
    return Array.from(s).sort();
  }, [issues]);

  const setField = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    onChange({ ...filters, [k]: v });

  const toggleIn = <T,>(set: Set<T>, v: T): Set<T> => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    return n;
  };

  const activeChips: { kind: string; value: string; remove: () => void }[] = [];
  filters.states.forEach((s) =>
    activeChips.push({ kind: "state", value: STATE_LABEL[s], remove: () => setField("states", toggleIn(filters.states, s)) }),
  );
  filters.labels.forEach((l) =>
    activeChips.push({ kind: "label", value: l, remove: () => setField("labels", toggleIn(filters.labels, l)) }),
  );
  filters.assignees.forEach((a) =>
    activeChips.push({ kind: "assignee", value: `@${a}`, remove: () => setField("assignees", toggleIn(filters.assignees, a)) }),
  );

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-[var(--color-line)] bg-[var(--color-bg2)]">
      <div className="flex items-center gap-2 flex-wrap">
        <SearchInput value={filters.q} onChange={(q) => setField("q", q)} />
        <Dropdown
          label="State"
          count={filters.states.size}
          options={STATE_ORDER.map((s) => ({
            key: s,
            label: STATE_LABEL[s],
            selected: filters.states.has(s),
            icon: <StateIcon state={s} size={11} />,
            toggle: () => setField("states", toggleIn(filters.states, s)),
          }))}
        />
        {allLabels.length > 0 && (
          <Dropdown
            label="Label"
            count={filters.labels.size}
            options={allLabels.map((l) => ({
              key: l,
              label: l,
              selected: filters.labels.has(l),
              icon: <LabelChip label={l} />,
              toggle: () => setField("labels", toggleIn(filters.labels, l)),
              raw: true,
            }))}
          />
        )}
        {allAssignees.length > 0 && (
          <Dropdown
            label="Assignee"
            count={filters.assignees.size}
            options={allAssignees.map((a) => ({
              key: a,
              label: `@${a}`,
              selected: filters.assignees.has(a),
              icon: <Avatar id={a} size={16} />,
              toggle: () => setField("assignees", toggleIn(filters.assignees, a)),
            }))}
          />
        )}
        <Button
          variant={filters.showCancelled ? "secondary" : "ghost"}
          size="xs"
          onClick={() => setField("showCancelled", !filters.showCancelled)}
          title={filters.showCancelled ? "Hide cancelled" : "Show cancelled"}
        >
          {filters.showCancelled ? "Hide cancelled" : "Show cancelled"}
        </Button>
        {(filters.states.size + filters.labels.size + filters.assignees.size > 0 || filters.q || filters.showCancelled) && (
          <Button variant="ghost" size="xs" onClick={() => onChange(emptyFilters())}>
            Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">{rightSlot}</div>
      </div>
      {activeChips.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {activeChips.map((c, i) => (
            <Button
              key={c.kind + c.value + i}
              variant="secondary"
              size="2xs"
              className="group"
              onClick={c.remove}
              aria-label={`Remove ${c.kind} filter ${c.value}`}
            >
              <span className="text-[var(--color-fg2)]">{c.kind}:</span>
              <span>{c.value}</span>
              <span className="text-[var(--color-fg3)] group-hover:text-[var(--color-err)]">×</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <svg
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-fg3)]"
        width="12" height="12" viewBox="0 0 14 14" fill="none"
      >
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search…"
        aria-label="Search issues"
        // Horizontal padding only clears the absolutely-positioned search/clear icons.
        className="pl-7 pr-7 w-52"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
        >
          <svg width="12" height="12" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </Button>
      )}
    </div>
  );
}

interface Option {
  key: string;
  label: string;
  selected: boolean;
  icon?: React.ReactNode;
  toggle: () => void;
  raw?: boolean;
}

function Dropdown({ label, count, options }: { label: string; count: number; options: Option[] }) {
  return (
    <Popover
      width={200}
      trigger={
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11.5px] rounded-md border cursor-pointer hm-soft ${
            count > 0
              ? "bg-[var(--color-bg4)] border-[var(--color-line2)] text-[var(--color-fg)]"
              : "bg-[var(--color-bg3)] border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
          }`}
        >
          {label}
          {count > 0 && (
            <span className="font-mono tabular-nums text-[10px] text-[var(--color-accent)]">{count}</span>
          )}
          <svg width="9" height="9" viewBox="0 0 10 10" className="text-[var(--color-fg3)]">
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          </svg>
        </span>
      }
    >
      {() => (
        <div className="flex flex-col gap-0.5 max-h-[280px] overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-[var(--color-fg3)]">No options</div>
          ) : (
            options.map((o) => (
              <MenuItem
                key={o.key}
                size="sm"
                variant={o.selected ? "default" : "muted"}
                selected={o.selected}
                onClick={o.toggle}
              >
                <span className="size-3 rounded-sm border flex items-center justify-center shrink-0"
                  style={{
                    color: "var(--color-fg)",
                    background: o.selected ? "var(--color-brand)" : "transparent",
                    borderColor: o.selected ? "var(--color-brand)" : "var(--color-line2)",
                  }}>
                  {o.selected && (
                    <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 5.2L4.2 7.2L8 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  )}
                </span>
                {o.raw ? o.icon : (<>{o.icon}<span>{o.label}</span></>)}
              </MenuItem>
            ))
          )}
        </div>
      )}
    </Popover>
  );
}
