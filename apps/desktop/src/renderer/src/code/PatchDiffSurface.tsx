/**
 * PatchDiffSurface — a single-file Pierre diff for the Code Workbench's Changes
 * view. Renders the raw `git diff` patch DIRECTLY via `@pierre/diffs`' `PatchDiff`
 * (the idiomatic, light path — no double file fetch), with split/unified +
 * expand-unchanged toggles AND inline review comments (gutter "+"/line click →
 * composer → annotation; "Send to Claude" ships the batch). The editable path is
 * the editor's own inline CodeMirror merge (the "Edit" button hands off to it).
 */
import { useState, type CSSProperties } from "react";
import { PatchDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { Columns2, Rows2, Pencil, UnfoldVertical, MessageSquarePlus, Play } from "lucide-react";
import { useGitDiff } from "../queries";
import { PIERRE_CSS_VARS, workerPoolOptions, workerHighlighterOptions } from "../pierre-codeview";
import { useReviewComments } from "./useReviewComments";

export function PatchDiffSurface({
  repoPath,
  file,
  fontSize = 13,
  onEdit,
  onClose,
}: {
  repoPath: string;
  file: string;
  fontSize?: number;
  /** Hand off to the editable editor tab for this file. */
  onEdit?: (file: string) => void;
  /** Close the review (back to the editor area). */
  onClose?: () => void;
}) {
  const [split, setSplit] = useState(false);
  const [expand, setExpand] = useState(false);
  const q = useGitDiff(repoPath, { kind: "working" }, file);
  const patch = q.data?.patch;
  const empty = patch != null && patch.trim() === "";
  const name = file.split("/").pop() ?? file;
  const dir = file.slice(0, file.length - name.length).replace(/\/$/, "");
  const review = useReviewComments(repoPath, file);

  return (
    <div
      className="h-full flex flex-col bg-[var(--color-bg2)]"
      style={{ ...PIERRE_CSS_VARS, "--diffs-font-size": `${fontSize}px` } as CSSProperties}
    >
      <div className="h-7 shrink-0 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)]">
        <span className="text-[var(--color-fg)] truncate" title={file}>{name}</span>
        {dir && <span className="text-[var(--color-fg3)] truncate">{dir}</span>}
        <span className="text-[var(--color-fg3)]">· vs HEAD</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setExpand((e) => !e)}
            className={`nodrag size-5 grid place-items-center rounded hover:bg-[var(--color-bg4)] ${expand ? "text-[var(--color-accent)]" : "text-[var(--color-fg3)] hover:text-[var(--color-fg)]"}`}
            title={expand ? "show changes only" : "expand unchanged context"}
            aria-label="toggle expand unchanged"
          >
            <UnfoldVertical size={12} />
          </button>
          <button
            onClick={() => setSplit((s) => !s)}
            className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
            title={split ? "unified view" : "split view"}
            aria-label="toggle split/unified"
          >
            {split ? <Rows2 size={12} /> : <Columns2 size={12} />}
          </button>
          {onEdit && (
            <button
              onClick={() => onEdit(file)}
              className="nodrag inline-flex items-center gap-1 px-1.5 h-5 rounded border border-[var(--color-line2)] text-[10px] text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)]"
              title="Edit this file in the editor"
            >
              <Pencil size={10} /> Edit
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] text-[12px] leading-none"
              aria-label="close diff"
            >×</button>
          )}
        </span>
      </div>
      <div ref={review.hostRef} className="relative flex-1 min-h-0 overflow-auto">
        {q.isLoading && <div className="p-3 text-[11px] text-[var(--color-fg3)]">loading diff…</div>}
        {q.error && (
          <div className="p-3 text-[11px] text-[var(--color-err)] font-mono">{(q.error as Error).message}</div>
        )}
        {empty && <div className="p-4 text-[11px] text-[var(--color-fg3)] font-mono">no changes vs HEAD</div>}
        {patch && !empty && (
          <WorkerPoolContextProvider poolOptions={workerPoolOptions} highlighterOptions={workerHighlighterOptions}>
            <PatchDiff
              patch={patch}
              lineAnnotations={review.lineAnnotations}
              renderAnnotation={review.renderAnnotation}
              options={{
                theme: { dark: "pierre-dark", light: "pierre-light" },
                themeType: "dark",
                diffStyle: split ? "split" : "unified",
                overflow: "scroll",
                diffIndicators: "bars",
                expandUnchanged: expand,
                collapsedContextThreshold: 3,
                expansionLineCount: 60,
                lineDiffType: "char",
                enableLineSelection: true,
                enableGutterUtility: true,
                lineHoverHighlight: "both",
                onGutterUtilityClick: review.onGutterUtilityClick,
                onLineNumberClick: review.onLineNumberClick,
              }}
            />
          </WorkerPoolContextProvider>
        )}
        {review.composerNode}
      </div>
      {/* Review batch bar — leave comments via the gutter "+" or a line number,
          then send them all to claude (spawns one if none is alive). */}
      {review.count > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 border-t border-[var(--color-line)] bg-[var(--color-bg3)] text-[11px]">
          <MessageSquarePlus size={12} className="text-[var(--color-warn)]" aria-hidden />
          <span className="text-[var(--color-warn)] font-medium">{review.count} comment{review.count > 1 ? "s" : ""}</span>
          <button
            onClick={review.sendReview}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-white bg-[var(--color-brand)] hover:opacity-90 text-[11px] font-medium"
            title="Send all comments on this file to claude"
          >
            <Play size={11} fill="currentColor" strokeWidth={0} aria-hidden /> Send to Claude
          </button>
          <button
            onClick={review.clearFile}
            className="text-[var(--color-fg3)] hover:text-[var(--color-err)] text-[10px]"
            title="discard this file's comments"
          >
            clear
          </button>
        </div>
      )}
    </div>
  );
}
