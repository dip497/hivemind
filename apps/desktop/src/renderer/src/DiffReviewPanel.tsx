/**
 * DiffReviewPanel — a GitHub-style review surface for the DiffTile. Lists every
 * review comment GROUPED BY FILE (unresolved first), each a thread you can
 * reply to, resolve, jump to in the diff, or send to claude. Rendered as a
 * collapsible right column inside the DiffTile; DiffTile owns the comment data
 * + actions.
 */
import { useState } from "react";
import type { ReviewComment } from "./diff-comments";

interface Props {
  comments: ReviewComment[];
  onJump: (c: ReviewComment) => void;
  onReply: (id: string, body: string) => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
  onSend: (c: ReviewComment) => void;
  onSendAll: () => void;
  onClose: () => void;
}

const fmtRange = (c: ReviewComment) => (c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–${c.endLine}`);

export function DiffReviewPanel({ comments, onJump, onReply, onResolve, onDelete, onSend, onSendAll, onClose }: Props) {
  const unresolved = comments.filter((c) => !c.resolved).length;
  // Group by file, unresolved threads first within each group.
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of [...comments].sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.startLine - b.startLine)) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }

  return (
    <aside className="nodrag flex flex-col w-[280px] shrink-0 border-l border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden">
      <header className="flex items-center gap-2 px-2.5 h-8 border-b border-[var(--color-line)] text-[11px] font-semibold text-[var(--color-fg2)]">
        <span>Review</span>
        <span className="font-mono text-[10px] text-[var(--color-fg3)] tabular-nums">
          {unresolved} open{comments.length > unresolved ? ` · ${comments.length - unresolved} resolved` : ""}
        </span>
        <button
          onClick={onSendAll}
          disabled={unresolved === 0}
          className="ml-auto px-1.5 py-0.5 rounded text-[10px] border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] disabled:opacity-30"
          title="Send all unresolved comments to claude"
        >
          send all
        </button>
        <button
          onClick={onClose}
          className="size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          aria-label="close review"
        >×</button>
      </header>

      <div className="flex-1 overflow-y-auto p-2 space-y-3 text-[12px]">
        {comments.length === 0 && (
          <div className="text-[11px] text-[var(--color-fg3)] px-1 py-2">
            No comments yet. Click a line number in the diff (or select a range) to comment — on any line, changed or not.
          </div>
        )}
        {[...byFile.entries()].map(([file, list]) => (
          <div key={file}>
            <div className="px-1 mb-1 font-mono text-[10px] text-[var(--color-fg3)] truncate" title={file}>
              {file}
            </div>
            <div className="space-y-1.5">
              {list.map((c) => (
                <CommentThread
                  key={c.id}
                  c={c}
                  onJump={() => onJump(c)}
                  onReply={(b) => onReply(c.id, b)}
                  onResolve={() => onResolve(c.id)}
                  onDelete={() => onDelete(c.id)}
                  onSend={() => onSend(c)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function CommentThread({
  c, onJump, onReply, onResolve, onDelete, onSend,
}: {
  c: ReviewComment;
  onJump: () => void;
  onReply: (body: string) => void;
  onResolve: () => void;
  onDelete: () => void;
  onSend: () => void;
}) {
  const [reply, setReply] = useState("");
  return (
    <div
      className={`rounded-md border p-2 ${
        c.resolved
          ? "border-[var(--color-line)] bg-[var(--color-bg)] opacity-70"
          : "border-[var(--color-line2)] bg-[var(--color-bg3)]"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-fg3)]">
        <button onClick={onJump} className="font-mono hover:text-[var(--color-accent)]" title="Jump to lines">
          {fmtRange(c)}
        </button>
        <span className="text-[var(--color-fg2)]">{c.author}</span>
        {c.resolved && <span className="text-[var(--color-ok)]">✓ resolved</span>}
        <span className="ml-auto">{c.at}</span>
      </div>
      <div className="mt-1 text-[var(--color-fg)] whitespace-pre-wrap break-words">{c.body}</div>
      {c.replies?.map((r, i) => (
        <div key={i} className="mt-1 pl-2 border-l border-[var(--color-line2)] text-[11px]">
          <span className="text-[10px] text-[var(--color-fg3)]">{r.author}</span>
          <div className="text-[var(--color-fg2)] whitespace-pre-wrap break-words">{r.body}</div>
        </div>
      ))}
      <div className="mt-1.5 flex items-center gap-1">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && reply.trim()) { onReply(reply.trim()); setReply(""); } }}
          placeholder="reply…"
          className="flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1.5 py-0.5 text-[11px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
        <button onClick={onResolve} className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)]">
          {c.resolved ? "reopen" : "resolve"}
        </button>
        <button onClick={onSend} className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-brand)]" title="Send this comment to claude">
          → claude
        </button>
        <button onClick={onDelete} className="ml-auto px-1.5 py-0.5 rounded text-[var(--color-fg3)] hover:text-[var(--color-err)]" title="Delete comment">
          delete
        </button>
      </div>
    </div>
  );
}
