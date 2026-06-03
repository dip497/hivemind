/**
 * WorktreePicker — Zed-style worktree chooser for a repo frame.
 *
 * Lists the repo's git worktrees (one row each: directory name + branch ·
 * short-sha · truncated path), marks the one already attached, and offers a
 * "Create new worktree based on <branch>" action. Picking a row attaches that
 * worktree to a frame (the caller spawns a nested sub-frame for it); creating
 * makes a fresh worktree first.
 *
 * Presentational + self-fetching: given a repoPath it loads worktreeList on
 * mount and reports the user's choice through onAttach / onCreate. The caller
 * portals this into a popover (FrameNode's AnchoredMenu).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Plus, Check, Loader2 } from "lucide-react";
import type { WorktreeEntry } from "../../shared/ipc";

/** Last path segment — the worktree's directory name (the bold first line). */
function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** Keep a path readable in a narrow row: head + tail with an ellipsis when long. */
function truncPath(p: string, max = 38): string {
  if (p.length <= max) return p;
  const tail = p.slice(-(max - 1));
  const cut = tail.indexOf("/");
  return "…" + (cut >= 0 ? tail.slice(cut) : tail);
}

export interface WorktreePickerProps {
  /** Repo whose worktrees we list + create under. */
  repoPath: string;
  /** Worktree path already attached to this frame (marked with a ✓). */
  activePath?: string;
  /** Attach an existing worktree → caller spawns a nested sub-frame for it. */
  onAttach: (entry: WorktreeEntry) => void;
  /** Create a new worktree on `branch`, then attach it. */
  onCreate: (branch: string) => void;
}

export function WorktreePicker({ repoPath, activePath, onAttach, onCreate }: WorktreePickerProps) {
  const [list, setList] = useState<WorktreeEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [branchDraft, setBranchDraft] = useState("");
  const createRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    window.hive
      .worktreeList(repoPath)
      .then((ws) => alive && setList(ws))
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [repoPath]);

  // The repo's checked-out branch = the main worktree (path === repoPath), used
  // to label "Create new worktree based on <branch>" like Zed.
  const baseBranch = useMemo(() => {
    const main = list?.find((w) => w.path === repoPath && !w.bare);
    return main?.branch ?? list?.find((w) => w.branch && !w.bare)?.branch ?? null;
  }, [list, repoPath]);

  const filtered = useMemo(() => {
    if (!list) return [];
    const rows = list.filter((w) => !w.bare);
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((w) =>
      `${baseName(w.path)} ${w.branch ?? ""} ${w.path}`.toLowerCase().includes(needle),
    );
  }, [list, q]);

  const submitCreate = () => {
    const b = branchDraft.trim();
    if (b) onCreate(b);
    setBranchDraft("");
    setCreating(false);
  };

  return (
    <div className="flex flex-col min-w-[320px] max-w-[420px]">
      {/* search */}
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Select a worktree…"
        className="m-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
      />

      {/* create */}
      {creating ? (
        <div className="flex items-center gap-1 px-1 pb-1">
          <input
            ref={createRef}
            autoFocus
            value={branchDraft}
            onChange={(e) => setBranchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") {
                setBranchDraft("");
                setCreating(false);
              }
            }}
            placeholder={baseBranch ? `new branch (from ${baseBranch})…` : "new branch name…"}
            className="flex-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[12px] font-mono text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
          />
          <button
            onClick={submitCreate}
            className="px-2 py-1 rounded text-[11px] text-[var(--color-brand)] hover:bg-[var(--color-bg3)]"
          >
            create
          </button>
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 mx-1 mb-1 px-2 py-1.5 rounded text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg3)]"
        >
          <Plus size={13} className="text-[var(--color-brand)]" />
          <span>
            Create new worktree{baseBranch ? <span className="text-[var(--color-fg2)]"> based on {baseBranch}</span> : ""}
          </span>
        </button>
      )}

      <div className="h-px bg-[var(--color-line2)] mx-1" />

      {/* list */}
      <div className="max-h-[280px] overflow-y-auto py-1">
        {err ? (
          <div className="px-3 py-2 text-[11px] text-[var(--color-err)]">{err}</div>
        ) : list === null ? (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--color-fg3)]">
            <Loader2 size={12} className="animate-spin" /> loading worktrees…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)]">no worktrees</div>
        ) : (
          filtered.map((w) => {
            const active = !!activePath && w.path === activePath;
            return (
              <button
                key={w.path}
                onClick={() => onAttach(w)}
                className={`w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--color-bg3)] ${
                  active ? "bg-[var(--color-bg3)]" : ""
                }`}
              >
                <GitBranch size={12} className="mt-0.5 shrink-0 text-[var(--color-fg2)]" />
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg)]">
                    <span className="truncate font-medium">{baseName(w.path)}</span>
                    {active && <Check size={11} className="shrink-0 text-[var(--color-brand)]" />}
                  </span>
                  <span className="truncate text-[10px] font-mono text-[var(--color-fg3)]">
                    {w.branch ?? "detached"} · {w.head.slice(0, 7)} · {truncPath(w.path)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
