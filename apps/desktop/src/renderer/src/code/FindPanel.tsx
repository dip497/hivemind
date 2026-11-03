/**
 * Find in files (Ctrl+Shift+F): every line holding the text, grouped by file, a page at a time
 * (`code.grep`, fff on the host, which searches the files you use most first and keeps to a time
 * budget). Only the rows in sight are drawn (`@tanstack/react-virtual`), so ten thousand matches
 * cost what a screenful does. Typing waits 200 ms before it asks; the next page is asked for as the
 * list nears its end.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FoundLine, GrepMode } from "@hivemind/workspace-api/code";
import { Button } from "../components/ui/button";

type Row = { kind: "file"; path: string; count: number } | { kind: "line"; hit: FoundLine };

export function FindPanel({ repoPath, onOpen, autoFocus = true }: {
  repoPath: string;
  onOpen: (path: string, line: number, col: number) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<GrepMode>("plain");
  const [caseSensitive, setCaseSensitive] = useState(false);
  useEffect(() => { const t = setTimeout(() => setQuery(text), 200); return () => clearTimeout(t); }, [text]);

  const q = useInfiniteQuery({
    queryKey: ["code:grep", repoPath, query, mode, caseSensitive],
    queryFn: ({ pageParam }) => window.hive.codeGrep(repoPath, query, { mode, caseSensitive, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: query.trim().length > 0,
  });
  const lines = useMemo(() => q.data?.pages.flatMap((p) => p.lines) ?? [], [q.data]);
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l.path, (counts.get(l.path) ?? 0) + 1);
    let last = "";
    for (const l of lines) {
      if (l.path !== last) { out.push({ kind: "file", path: l.path, count: counts.get(l.path)! }); last = l.path; }
      out.push({ kind: "line", hit: l });
    }
    return out;
  }, [lines]);

  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 24, overscan: 12 });
  const items = v.getVirtualItems();
  // The next page once the last rows come into sight.
  useEffect(() => {
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.index >= rows.length - 20 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [items, rows.length, q]);

  const page = q.data?.pages[q.data.pages.length - 1];
  const files = new Set(lines.map((l) => l.path)).size;
  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-bg2)]" data-find>
      <div className="shrink-0 p-2 border-b border-[var(--color-line)] flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find in files" aria-label="Find in files" autoFocus={autoFocus} spellCheck={false}
            className="nodrag flex-1 min-w-0 h-7 px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-line2)] text-label text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] placeholder:text-[var(--color-fg3)]" />
          <Button size="micro" variant={caseSensitive ? "secondary" : "ghost"} aria-pressed={caseSensitive} title="Match case" aria-label="Match case" onClick={() => setCaseSensitive((c) => !c)}>Aa</Button>
          <Button size="micro" variant={mode === "regex" ? "secondary" : "ghost"} aria-pressed={mode === "regex"} title="Regular expression" aria-label="Regular expression" onClick={() => setMode((m) => (m === "regex" ? "plain" : "regex"))}>.*</Button>
          <Button size="micro" variant={mode === "fuzzy" ? "secondary" : "ghost"} aria-pressed={mode === "fuzzy"} title="Fuzzy: close matches too" aria-label="Fuzzy" onClick={() => setMode((m) => (m === "fuzzy" ? "plain" : "fuzzy"))}>~</Button>
        </div>
        <div className="text-count text-[var(--color-fg3)] h-4" data-find-summary>
          {q.isFetching && !q.isFetchingNextPage ? "searching…"
            : query.trim() ? `${lines.length}${q.hasNextPage ? "+" : ""} result${lines.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}${page?.engine === "git" ? " (git grep)" : ""}`
            : ""}
          {page?.note && <span className="ml-1 text-[var(--color-fg2)]">· {page.note}</span>}
          {q.error && <span className="text-[var(--color-err)]">{(q.error as Error).message}</span>}
        </div>
      </div>
      <div ref={scroller} className="nowheel flex-1 min-h-0 overflow-y-auto" role="list" aria-label="Results">
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {items.map((it) => {
            const row = rows[it.index]!;
            const style = { position: "absolute" as const, top: 0, left: 0, right: 0, height: it.size, transform: `translateY(${it.start}px)` };
            if (row.kind === "file") {
              return (
                <div key={it.key} style={style} className="flex items-center gap-2 px-2 text-label font-semibold text-[var(--color-fg)] truncate" data-find-file={row.path}>
                  <span className="truncate">{row.path}</span><span className="ml-auto text-count font-normal text-[var(--color-fg3)]">{row.count}</span>
                </div>
              );
            }
            const h = row.hit;
            const [from, to] = h.ranges[0] ?? [0, 0];
            return (
              <div key={it.key} style={style} role="listitem" data-find-line={`${h.path}:${h.line}`}
                className="flex items-center gap-2 pl-5 pr-2 cursor-pointer hover:bg-[var(--color-bg3)] font-mono text-count text-[var(--color-fg2)] whitespace-pre overflow-hidden"
                onClick={() => onOpen(h.path, h.line, h.col)} title={`${h.path}:${h.line}`}>
                <span className="shrink-0 w-8 text-right text-[var(--color-fg3)] tabular-nums">{h.line}</span>
                <span className="truncate">{h.text.slice(0, from).trimStart()}<mark className="bg-[var(--color-bg4)] text-[var(--color-fg)] rounded-sm">{h.text.slice(from, to)}</mark>{h.text.slice(to)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
