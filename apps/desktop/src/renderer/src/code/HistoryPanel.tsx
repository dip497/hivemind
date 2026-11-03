/**
 * History in Changes (docs/design/git-history-2026-11-02.md §5.8): the log, newest first, with the
 * graph's lanes; or one file's history through its renames. A page at a time (`git.log`,
 * `git.fileHistory`), the next one asked for as the list nears its end, so the first screen is
 * drawn from the first page alone. Picking a commit shows its diff in the diff surface beside it.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { FileHistoryCursor, FileHistoryEntry, LogCommit } from "@hivemind/workspace-api/git";
import { Button } from "../components/ui/button";
import { X } from "../components/icons";
import { laneRows, type LaneRow } from "./history-lanes";

/** "now", "5m", "3h", "2d", "4w", "7mo", "2y": how long ago, in the list's narrow column. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - seconds);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 60) return `${Math.floor(s / (86400 * 7))}w`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

/** Lane colours: the app's quiet ones, none of the status colours' meanings. */
const LANE_COLOURS = ["var(--color-info)", "var(--color-ok)", "var(--color-fg2)", "var(--color-accent)", "var(--color-fg3)"];
const LANE_W = 10;
const ROW_H = 26;

function Lanes({ row, width }: { row: LaneRow; width: number }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const colour = (lane: number) => LANE_COLOURS[lane % LANE_COLOURS.length];
  return (
    <svg width={width * LANE_W} height={ROW_H} className="shrink-0" aria-hidden>
      {row.up.map((l, i) => <line key={`u${i}`} x1={x(l.from)} y1={0} x2={x(l.to)} y2={mid} stroke={colour(l.from)} strokeWidth={1.5} />)}
      {row.down.map((l, i) => <line key={`d${i}`} x1={x(l.from)} y1={mid} x2={x(l.to)} y2={ROW_H} stroke={colour(l.to)} strokeWidth={1.5} />)}
      <circle cx={x(row.lane)} cy={mid} r={3.5} fill="var(--color-bg2)" stroke={colour(row.lane)} strokeWidth={2} />
    </svg>
  );
}

export function HistoryPanel({ repoPath, file, onClearFile, all, onAll, selected, onSelect, width }: {
  repoPath: string;
  /** One file's history, or the log when null. */
  file: string | null;
  onClearFile: () => void;
  /** Every branch by date, as against the current one. */
  all: boolean;
  onAll: (all: boolean) => void;
  selected: string | null;
  onSelect: (sha: string) => void;
  width: number;
}) {
  const log = useInfiniteQuery({
    queryKey: ["git:log", repoPath, all],
    queryFn: ({ pageParam }) => window.hive.gitLog(repoPath, { all, cursor: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: file === null,
  });
  const history = useInfiniteQuery({
    queryKey: ["git:fileHistory", repoPath, file],
    queryFn: ({ pageParam }) => window.hive.gitFileHistory(repoPath, file!, pageParam ?? undefined),
    initialPageParam: null as FileHistoryCursor | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: file !== null,
  });
  const q = file === null ? log : history;
  const commits: LogCommit[] = useMemo(() => log.data?.pages.flatMap((p) => p.commits) ?? [], [log.data]);
  const entries: FileHistoryEntry[] = useMemo(() => history.data?.pages.flatMap((p) => p.entries) ?? [], [history.data]);
  // Lanes for the log only: a file's history skips commits, so it has no graph to draw.
  const lanes = useMemo(() => (file === null ? laneRows(commits).rows : []), [file, commits]);
  const laneWidth = Math.min(8, Math.max(1, ...lanes.map((r) => r.width)));

  // The next page as the end comes into sight.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const seen = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); });
    seen.observe(el);
    return () => seen.disconnect();
  }, [q]);

  // The newest is shown until the person picks another.
  const first = file === null ? commits[0]?.oid : entries[0]?.oid;
  useEffect(() => { if (!selected && first) onSelect(first); }, [selected, first, onSelect]);

  const rows = file === null
    ? commits.map((c, i) => ({ oid: c.oid, subject: c.subject, author: c.author, time: c.time, refs: c.refs, lane: lanes[i], renamedFrom: undefined as string | undefined, path: undefined as string | undefined }))
    : entries.map((e) => ({ oid: e.oid, subject: e.subject, author: e.author, time: e.time, refs: [] as string[], lane: undefined, renamedFrom: e.renamedFrom, path: e.path }));

  return (
    <aside className="nodrag shrink-0 flex flex-col border-r border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden" style={{ width }} data-history>
      <div className="h-8 shrink-0 flex items-center gap-1.5 px-2 border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)]">
        {file === null ? (
          <div className="inline-flex rounded-md overflow-hidden bg-[var(--color-bg)] border border-[var(--color-line2)]">
            <Button size="2xs" variant={all ? "ghost" : "secondary"} onClick={() => onAll(false)} title="The current branch, as git walks it">this branch</Button>
            <Button size="2xs" variant={all ? "secondary" : "ghost"} onClick={() => onAll(true)} title="Every branch, newest first">all branches</Button>
          </div>
        ) : (
          <>
            <span className="truncate text-[var(--color-fg)]" title={file} data-history-file>history of {file.split("/").pop()}</span>
            <Button variant="ghost" size="icon-micro" className="ml-auto" aria-label="Show the whole log" title="Show the whole log" onClick={onClearFile}><X /></Button>
          </>
        )}
      </div>
      <div role="listbox" aria-label={file ? `History of ${file}` : "Commits"} className="flex-1 min-h-0 overflow-y-auto">
        {q.isLoading && <div className="p-3 text-count text-[var(--color-fg3)]">loading history…</div>}
        {q.error && <div className="p-3 text-count text-[var(--color-err)]">{(q.error as Error).message}</div>}
        {!q.isLoading && !q.error && rows.length === 0 && <div className="p-3 text-count text-[var(--color-fg3)]">no commits yet</div>}
        {rows.map((r) => {
          const on = r.oid === selected;
          return (
            <div key={`${r.oid}:${r.path ?? ""}`} role="option" aria-selected={on} data-commit={r.oid}
              className={`flex items-center gap-1.5 pr-2 cursor-pointer ${on ? "bg-[var(--color-bg4)]" : "hover:bg-[var(--color-bg3)]"} ${r.lane ? "" : "pl-2"}`}
              style={{ height: ROW_H }} title={`${r.subject}\n${r.author} · ${new Date(r.time * 1000).toLocaleString()} · ${r.oid.slice(0, 10)}`}
              onClick={() => onSelect(r.oid)}>
              {r.lane && <Lanes row={r.lane} width={laneWidth} />}
              <span className="flex-1 min-w-0 truncate text-label text-[var(--color-fg)]">
                {r.refs.map((ref) => <span key={ref} className="mr-1 px-1 rounded-sm border border-[var(--color-line2)] text-count font-mono text-[var(--color-fg2)]">{ref.replace(/^HEAD -> /, "")}</span>)}
                {r.subject}
                {r.renamedFrom && <span className="ml-1 text-count text-[var(--color-fg3)]">(from {r.renamedFrom})</span>}
              </span>
              <span className="shrink-0 text-count text-[var(--color-fg3)] tabular-nums">{ago(r.time)}</span>
            </div>
          );
        })}
        <div ref={end} className="h-6">{q.isFetchingNextPage && <span className="px-2 text-count text-[var(--color-fg3)]">loading more…</span>}</div>
      </div>
    </aside>
  );
}

/** Above a commit's diff: its message whole, who and when, and how many files. */
export function CommitHeader({ repoPath, sha }: { repoPath: string; sha: string }) {
  const q = useQuery({ queryKey: ["git:commitInfo", repoPath, sha], queryFn: () => window.hive.gitCommitInfo(repoPath, sha), staleTime: Infinity });
  if (!q.data) return null;
  const [subject, ...body] = q.data.message.split("\n");
  const add = q.data.files.reduce((n, f) => n + (f.add ?? 0), 0);
  const del = q.data.files.reduce((n, f) => n + (f.del ?? 0), 0);
  return (
    <div className="shrink-0 px-3 py-2 border-b border-[var(--color-line)] bg-[var(--color-bg2)]" data-commit-header={sha}>
      <div className="text-row font-semibold text-[var(--color-fg)]">{subject}</div>
      {body.join("\n").trim() && <div className="mt-1 whitespace-pre-wrap text-label text-[var(--color-fg2)] max-h-24 overflow-y-auto">{body.join("\n").trim()}</div>}
      <div className="mt-1 flex gap-2 text-count font-mono text-[var(--color-fg3)]">
        <span>{q.data.author}</span><span>{new Date(q.data.time * 1000).toLocaleString()}</span><span>{sha.slice(0, 10)}</span>
        <span>{q.data.files.length} file{q.data.files.length === 1 ? "" : "s"}</span>
        <span className="text-[var(--color-ok)]">+{add}</span><span className="text-[var(--color-err)]">−{del}</span>
      </div>
    </div>
  );
}
