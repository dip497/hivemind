/**
 * One way to ask "which one?": a modal list, searchable once it is long, its rows under group
 * headings, chosen by click or by arrows and Enter. Esc or a click outside cancels. The extra rows
 * (start a new one…) sit below the list and are never filtered away.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { MenuItem } from "./components/ui/menu-item";

export interface PickerRow {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Said on the right of the row, quietly. */
  detail?: string;
  group?: string;
  indent?: boolean;
}

const SEARCH_FROM = 7;

export function PickerDialog({ title, description, rows, extra = [], onPick, onClose }: {
  title: string;
  /** What is being sent or started, under the title. */
  description?: string;
  rows: PickerRow[];
  extra?: PickerRow[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => `${r.label} ${r.detail ?? ""} ${r.group ?? ""}`.toLowerCase().includes(q)) : rows;
  }, [rows, query]);
  const all = [...shown, ...extra];
  const pick = (id: string) => { onClose(); onPick(id); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, all.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && all[active]) { e.preventDefault(); pick(all[active]!.id); }
  };
  const row = (r: PickerRow, i: number) => (
    <MenuItem key={r.id} variant="muted" selected={i === active} data-picker-row={r.id}
      onMouseEnter={() => setActive(i)} onClick={() => pick(r.id)} style={r.indent ? { paddingLeft: 22 } : undefined}>
      {r.icon && <span className="grid size-4 shrink-0 place-items-center text-[var(--color-fg3)]">{r.icon}</span>}
      <span className="flex-1 truncate">{r.label}</span>
      {r.detail && <span className="shrink-0 text-[10.5px] text-[var(--color-fg3)]">{r.detail}</span>}
    </MenuItem>
  );
  let lastGroup: string | undefined;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent ref={card} tabIndex={-1} padding="none" className="z-[10000] w-[380px] max-w-[92vw] gap-0 overflow-hidden outline-none" onKeyDown={onKeyDown}
        // The search box takes the keys when there is one; else the card, for the arrows and Enter.
        onOpenAutoFocus={(e) => { if (rows.length < SEARCH_FROM) { e.preventDefault(); card.current?.focus(); } }}>
        <div className="border-b border-[var(--color-line)] px-3.5 pb-2.5 pt-3 pr-10">
          <DialogTitle className="text-[13px] font-semibold">{title}</DialogTitle>
          {description && <DialogDescription className="mt-1 line-clamp-2 text-[11.5px] text-[var(--color-fg3)]">{description}</DialogDescription>}
        </div>
        {rows.length >= SEARCH_FROM && (
          <div className="px-2 pt-2">
            <Input value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} placeholder="Search" aria-label="Search" className="h-7 text-[12px]" />
          </div>
        )}
        <div className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5" role="listbox" aria-label={title}>
          {shown.length === 0 && <p className="px-2 py-3 text-[12px] text-[var(--color-fg3)]">Nothing matches.</p>}
          {shown.map((r, i) => {
            const heading = r.group && r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return [
              heading && <div key={`g:${heading}`} className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-fg3)] first:pt-0.5">{heading}</div>,
              row(r, i),
            ];
          })}
          {extra.length > 0 && <div className="my-1 border-t border-[var(--color-line2)]" />}
          {extra.map((r, i) => row(r, shown.length + i))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
