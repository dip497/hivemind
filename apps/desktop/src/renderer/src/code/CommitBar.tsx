/**
 * CommitBar — stage-all · editable message · Commit · Push, for the working tree.
 * Extracted from DiffTile so the standalone Diff tile AND the Code Workbench's
 * Changes view share one commit affordance. Adopts Nyx's ZoneToolbar model;
 * AI-generated messages are intentionally deferred (manual first).
 */
import { useState } from "react";
import type { GitStatusSnapshot } from "../../../shared/ipc";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
        <Button
          variant="outline"
          size="xs"
          title="stage all changes"
          onClick={() => stageMut.mutate({ repoPath, files: unstaged.map((f) => f.path) })}
        >
          stage all
        </Button>
      )}
      {status.files.length === 0 ? (
        <span className="flex-1 text-[var(--color-fg3)]">
          {status.ahead > 0 ? `✓ clean · ${status.ahead} commit${status.ahead > 1 ? "s" : ""} to push` : "✓ working tree clean"}
        </span>
      ) : (
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit(); }}
          placeholder={staged.length ? "commit message · ⌘↵" : "stage files to commit"}
          disabled={staged.length === 0}
          className="nodrag flex-1"
        />
      )}
      {status.files.length > 0 && (
        <Button size="xs" disabled={!canCommit} onClick={doCommit}>
          {commitMut.isPending ? "…" : "commit"}
        </Button>
      )}
      <Button
        variant="outline"
        size="xs"
        title={`push${status.ahead ? ` (${status.ahead} ahead)` : ""}`}
        disabled={pushMut.isPending}
        onClick={() => pushMut.mutate({ repoPath, setUpstream: !status.upstream })}
      >
        push{status.ahead ? ` ↑${status.ahead}` : ""}
      </Button>
    </div>
  );
}
