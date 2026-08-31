/**
 * GitCommitModal — a focused commit/sync dialog scoped to ONE repo (a frame's
 * repo, worktree, or workspace zone). Opened from the frame header's git button
 * or the rail context menu's "Git ▸ Commit…". Reuses the existing git hooks
 * (useGitStatus/Commit/Push/Pull/StageFiles) — no new IPC beyond gitPull.
 *
 * Fields: a one-line Summary and an optional multi-line Description; the final
 * commit message is `summary` + (blank line + description) when a body exists —
 * the standard git subject/body convention. A "Stage all changes" toggle
 * (defaulting on when nothing is staged yet) stages the working tree before the
 * commit, so a quick "type a message → Commit" flow just works.
 *
 * Actions: Commit · Commit & Push · Push · Pull. Push shows the ahead count and
 * sets upstream on first push; Pull is fast-forward-only (see gitPull). Commit
 * and Commit&Push require a summary + something to commit; Push/Pull don't.
 */
import { useEffect, useState } from "react";
import { GitCommitHorizontal, ArrowUp, ArrowDown, Loader2, X } from "lucide-react";
import { useGitStatus, useGitCommit, useGitPush, useGitPull, useStageFiles } from "./queries";

export function GitCommitModal({
  repoPath,
  open,
  onOpenChange,
}: {
  /** The repo to operate on (a frame's worktree/workspace/base repo). */
  repoPath: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [stageAll, setStageAll] = useState(true);

  const { data: status } = useGitStatus(open ? repoPath : null);
  const commitMut = useGitCommit();
  const pushMut = useGitPush();
  const pullMut = useGitPull();
  const stageMut = useStageFiles();

  // Reset the message when the dialog reopens (a fresh commit each time).
  useEffect(() => {
    if (open) { setSummary(""); setDescription(""); }
  }, [open]);
  // Escape closes the dialog, matching every other modal/menu in the app.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);
  // Default the stage-all toggle to ON when nothing is staged yet (the common
  // "commit everything" case), OFF when the user already curated an index.
  useEffect(() => {
    if (open && status) setStageAll(status.files.filter((f) => f.staged).length === 0);
  }, [open, status]);

  if (!open) return null;

  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged && f.status !== "ignored");
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const branch = status?.branch ?? "—";

  const busy = commitMut.isPending || pushMut.isPending || pullMut.isPending || stageMut.isPending;
  // Something to commit: either already-staged files, or unstaged files we'll
  // stage via the toggle. A summary is always required.
  const willStage = stageAll && unstaged.length > 0;
  const hasStagedContent = staged.length > 0 || willStage;
  const canCommit = !busy && summary.trim().length > 0 && hasStagedContent;
  const canPush = !busy && ahead > 0;
  const canPull = !busy && !!repoPath;

  const message = () => {
    const s = summary.trim();
    const d = description.trim();
    return d ? `${s}\n\n${d}` : s;
  };

  // Stage (if requested) then commit. Returns the commit result so a caller can
  // chain a push. Throws on failure so the chain stops (no push of nothing).
  const doStageAndCommit = async (): Promise<void> => {
    if (willStage) await stageMut.mutateAsync({ repoPath: repoPath!, files: unstaged.map((f) => f.path) });
    await commitMut.mutateAsync({ repoPath: repoPath!, message: message() });
    setSummary("");
    setDescription("");
  };

  const onCommit = () => { if (canCommit) void doStageAndCommit().catch(() => {}); };
  const onCommitPush = () => {
    if (!canCommit) return;
    // Both mutations already toast on failure (useGitCommit/useGitPush's
    // onError); this `.catch` only swallows the rejection that would
    // otherwise propagate as an unhandled promise rejection when the commit
    // (or the chained push) fails.
    void doStageAndCommit()
      .then(() => pushMut.mutateAsync({ repoPath: repoPath!, setUpstream: !status?.upstream }))
      .catch(() => {});
  };
  const onPush = () => { if (canPush) pushMut.mutate({ repoPath: repoPath!, setUpstream: !status?.upstream }); };
  const onPull = () => { if (canPull) pullMut.mutate({ repoPath: repoPath! }); };

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[460px] max-w-[92vw] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <GitCommitHorizontal size={16} className="text-[var(--color-fg2)]" />
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Commit</h2>
          <button
            onClick={() => onOpenChange(false)}
            className="ml-auto size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Status summary — branch, staged/changed counts, ahead/behind. */}
        <div className="mt-2 flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono text-[var(--color-fg3)]">
          <span className="text-[var(--color-fg2)]">{branch}</span>
          <span title={`${staged.length} staged · ${unstaged.length} unstaged`}>
            <span className="text-[var(--color-ok)]">{staged.length}</span>
            <span className="text-[var(--color-fg3)]">/{files.length} staged</span>
          </span>
          {ahead > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-fg2)]"><ArrowUp size={11} />{ahead}</span>}
          {behind > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-warn)]"><ArrowDown size={11} />{behind}</span>}
          {files.length === 0 && ahead === 0 && behind === 0 && <span>working tree clean</span>}
        </div>

        {/* Summary + description. */}
        <div className="mt-3 grid gap-2">
          <input
            autoFocus
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit(); }}
            placeholder="Summary (required)"
            className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
            aria-label="Commit summary"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={4}
            className="w-full resize-y bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] leading-relaxed"
            aria-label="Commit description"
          />
        </div>

        {/* Stage-all toggle. */}
        <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-fg2)] select-none cursor-pointer">
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(e) => setStageAll(e.target.checked)}
            disabled={unstaged.length === 0}
            className="accent-[var(--color-brand)]"
          />
          Stage all changes
          {unstaged.length > 0 && <span className="text-[var(--color-fg3)] font-mono">({unstaged.length})</span>}
        </label>

        {/* Actions — Sync (pull/push) on the left, Commit on the right. All
            four are always shown; push/pull disable only when there's nothing to
            sync (the counts + tooltip say why). */}
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={onPull}
            disabled={!canPull}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed"
            title="Update this branch from upstream (fast-forward only)"
          >
            {pullMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <ArrowDown size={13} />}
            Pull{behind > 0 ? ` ↓${behind}` : ""}
          </button>
          <button
            onClick={onPush}
            disabled={!canPush}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed"
            title={ahead > 0 ? `Push ${ahead} commit(s)` : "Nothing to push yet"}
          >
            {pushMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={13} />}
            Push{ahead > 0 ? ` ↑${ahead}` : ""}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onCommit}
              disabled={!canCommit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded border border-[var(--color-line2)] text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed"
              title="Commit staged changes (⌘↵)"
            >
              {commitMut.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
              Commit
            </button>
            <button
              onClick={onCommitPush}
              disabled={!canCommit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded text-white bg-[var(--color-brand)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Commit, then push"
            >
              {(commitMut.isPending || pushMut.isPending) ? <Loader2 size={13} className="animate-spin" /> : null}
              Commit &amp; Push
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
