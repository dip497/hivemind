/**
 * The Code tile's Outline: the file's classes, functions and their members as a tree, the one
 * holding the cursor marked, a filter that keeps the matches and what holds them. Clicking a name
 * goes to it. Answers come from tree-sitter (`codeIntel.outline`), so the outline follows typing.
 */
import { useMemo, useState } from "react";
import type { CodeSymbol, Place, SymbolKind } from "@hivemind/code-intel/contract";

const KIND_MARK: Record<SymbolKind, string> = {
  function: "ƒ", method: "m", class: "C", interface: "I", type: "T", enum: "E", variable: "v", constant: "c",
  field: "f", property: "p", module: "N", constructor: "new",
};

/** The symbols whose name holds `filter`, with every symbol that holds one of them. */
function kept(symbols: CodeSymbol[], filter: string): CodeSymbol[] {
  if (!filter) return symbols;
  const f = filter.toLowerCase();
  const out: CodeSymbol[] = [];
  for (const s of symbols) {
    const children = kept(s.children, filter);
    if (children.length || s.name.toLowerCase().includes(f)) out.push(children === s.children ? s : { ...s, children });
  }
  return out;
}

/** The innermost symbol holding `line`, to mark. */
function holding(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  for (const s of symbols) {
    if (s.span.start.line <= line && line <= s.span.end.line) return holding(s.children, line) ?? s;
  }
  return null;
}

export function OutlinePanel({ symbols, cursorLine, onPick, loading = false }: {
  /** Null before the first answer. */
  symbols: CodeSymbol[] | null;
  cursorLine?: number;
  onPick: (at: Place) => void;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => kept(symbols ?? [], filter.trim()), [symbols, filter]);
  const here = cursorLine === undefined ? null : holding(shown, cursorLine);

  const tree = (list: CodeSymbol[], depth: number) => (
    <ul className="flex flex-col" aria-label={depth === 0 ? "Outline" : undefined}>
      {list.map((s) => (
        <li key={`${s.nameAt.line}:${s.nameAt.col}:${s.name}`}>
          <button type="button" data-outline-symbol={s.name} aria-current={s === here ? "location" : undefined}
            className={`w-full flex items-center gap-1.5 h-6 pr-2 text-left text-label truncate rounded-sm hover:bg-[var(--color-bg3)] focus-visible:bg-[var(--color-bg3)] ${s === here ? "bg-[var(--color-bg3)] text-[var(--color-fg)]" : "text-[var(--color-fg2)]"}`}
            style={{ paddingLeft: 8 + depth * 12 }} title={`${s.kind} ${s.name}, line ${s.nameAt.line}`}
            onClick={() => onPick(s.nameAt)}>
            <span className="shrink-0 w-6 text-center font-mono text-count text-[var(--color-fg3)]" aria-hidden>{KIND_MARK[s.kind]}</span>
            <span className="truncate">{s.name}</span>
          </button>
          {s.children.length > 0 && tree(s.children, depth + 1)}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-bg2)]" data-outline>
      <div className="shrink-0 p-2 border-b border-[var(--color-line)]">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter the outline" aria-label="Filter the outline" spellCheck={false}
          className="nodrag w-full h-7 px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-line2)] text-label text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] placeholder:text-[var(--color-fg3)]" />
      </div>
      <div className="nowheel flex-1 min-h-0 overflow-y-auto py-1">
        {symbols === null
          ? <p className="px-3 py-2 text-count text-[var(--color-fg3)]">{loading ? "Reading the file…" : "No outline for this file"}</p>
          : shown.length === 0
            ? <p className="px-3 py-2 text-count text-[var(--color-fg3)]">{filter ? "Nothing matches" : "Nothing declared in this file"}</p>
            : tree(shown, 0)}
      </div>
    </div>
  );
}
