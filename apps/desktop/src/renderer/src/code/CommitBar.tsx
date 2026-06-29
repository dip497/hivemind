/**
 * CommitBar — stage-all · editable message · Commit · Push, for the working tree.
 * Extracted from DiffTile so the standalone Diff tile AND the Code Workbench's
 * Changes view share one commit affordance. Adopts Nyx's ZoneToolbar model;
 * AI-generated messages are intentionally deferred (manual first).
 */
import { useState } from "react";
import type { GitStatusSnapshot } from "../../../shared/ipc";
import { useGitCommit, useGitPush, useStageFiles } from "../queries";

export function CommitBar({ repoPath, status }: { repoPath: string; status: GitStatusSnapshot }) {
  const [message, setMessage] = useState("");
  const commitMut = useGitCommit();
  const pushMut = useGitPush();
  const stageMut = useStageFiles();

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => !f.staged && f.status !== "ignored");
  const canCommit = staged.length > 0 && message.trim().length > 0 && !commitMut.isPending;

  const doCommit = () => {
    if (!canCommit) return;
    commitMut.mutate({ repoPath, message: message.trim() }, { onSuccess: () => setMessage("") });
  };

  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-bg3)] px-2.5 py-1.5 flex items-center gap-2 text-[11px] font-mono">
      {status.files.length > 0 && (
        <span className="text-[var(--color-fg3)] tabular-nums shrink-0" title={`${staged.length} staged · ${unstaged.length} unstaged`}>
          <span className="text-[var(--color-ok)]">{staged.length}</span>/{status.files.length}
        </span>
      )}
      {unstaged.length > 0 && (
        <button
          className="shrink-0 px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg)] text-[10px]"
          title="stage all changes"
          onClick={() => stageMut.mutate({ repoPath, files: unstaged.map((f) => f.path) })}
        >
          stage all
        </button>
      )}
      {status.files.length === 0 ? (
        <span className="flex-1 text-[var(--color-fg3)]">
          {status.ahead > 0 ? `✓ clean · ${status.ahead} commit${status.ahead > 1 ? "s" : ""} to push` : "✓ working tree clean"}
        </span>
      ) : (
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit(); }}
          placeholder={staged.length ? "commit message · ⌘↵" : "stage files to commit"}
          disabled={staged.length === 0}
          className="nodrag flex-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-0.5 text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
      )}
      {status.files.length > 0 && (
        <button
          className="shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: canCommit ? "var(--color-accent)" : "var(--color-bg4)", color: canCommit ? "var(--color-bg)" : "var(--color-fg3)" }}
          disabled={!canCommit}
          onClick={doCommit}
        >
          {commitMut.isPending ? "…" : "commit"}
        </button>
      )}
      <button
        className="shrink-0 px-2 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] text-[10px] disabled:opacity-40 inline-flex items-center gap-1"
        title={`push${status.ahead ? ` (${status.ahead} ahead)` : ""}`}
        disabled={pushMut.isPending}
        onClick={() => pushMut.mutate({ repoPath, setUpstream: !status.upstream })}
      >
        push{status.ahead ? ` ↑${status.ahead}` : ""}
      </button>
    </div>
  );
}
