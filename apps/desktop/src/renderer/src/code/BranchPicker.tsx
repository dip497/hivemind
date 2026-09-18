/**
 * Base/head branch chooser for the branch and unpushed diff modes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { MenuItem } from "../components/ui/menu-item";
import type { GitBranchList } from "../../../shared/ipc";

export function BranchPicker({
  label,
  value,
  onChange,
  branches,
  autoLabel,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  branches: GitBranchList | undefined;
  autoLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const local = (branches?.local ?? []).filter((b) => b.toLowerCase().includes(q));
  const remote = (branches?.remote ?? []).filter((b) => b.toLowerCase().includes(q));

  const pick = (v: string | undefined) => { onChange(v); setOpen(false); setQuery(""); };

  return (
    <div className="nodrag relative inline-flex items-center gap-1 text-[10px] font-mono" ref={ref}>
      <span className="text-[var(--color-fg3)]">{label}</span>
      <Button
        variant="outline"
        size="xs"
        font="mono"
        className="nodrag max-w-[150px]"
        onClick={() => setOpen((o) => !o)}
        title={value ?? autoLabel}
      >
        <span className="truncate">{value ?? autoLabel}</span>
        <ChevronDown aria-hidden />
      </Button>
      {open && (
        <div className="nodrag absolute z-50 left-0 top-full mt-1 w-60 flex flex-col bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg shadow-xl overflow-hidden">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-line2)]">
            <Search size={11} aria-hidden className="text-[var(--color-fg3)] shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter branches…"
              className="w-full bg-transparent text-[10px] font-mono text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <MenuItem size="sm" selected={value == null} onClick={() => pick(undefined)}>
              {autoLabel}
            </MenuItem>
            {local.length > 0 && (
              <div className="px-2 pt-1.5 pb-0.5 text-[8.5px] uppercase tracking-wider text-[var(--color-fg3)]">local</div>
            )}
            {local.map((b) => (
              <MenuItem
                key={`l:${b}`}
                size="sm"
                selected={value === b}
                className="truncate"
                onClick={() => pick(b)}
                title={b}
              >
                {b}
              </MenuItem>
            ))}
            {remote.length > 0 && (
              <div className="px-2 pt-1.5 pb-0.5 text-[8.5px] uppercase tracking-wider text-[var(--color-fg3)]">remote</div>
            )}
            {remote.map((b) => (
              <MenuItem
                key={`r:${b}`}
                size="sm"
                selected={value === b}
                className="truncate"
                onClick={() => pick(b)}
                title={b}
              >
                {b}
              </MenuItem>
            ))}
            {local.length === 0 && remote.length === 0 && (
              <div className="px-2 py-2 text-[var(--color-fg3)]">{branches ? "no match" : "loading…"}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
