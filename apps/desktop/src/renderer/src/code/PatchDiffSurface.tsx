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
import { Columns2, Rows2, Pencil, UnfoldVertical, MessageSquarePlus, Play, X } from "lucide-react";
import { Button } from "../components/ui/button";
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
          <Button
            variant={expand ? "secondary" : "ghost"}
            size="icon-2xs"
            className="nodrag"
            onClick={() => setExpand((e) => !e)}
            title={expand ? "show changes only" : "expand unchanged context"}
            aria-label="toggle expand unchanged"
          >
            <UnfoldVertical />
          </Button>
          <Button
            variant="ghost"
            size="icon-2xs"
            className="nodrag"
            onClick={() => setSplit((s) => !s)}
            title={split ? "unified view" : "split view"}
            aria-label="toggle split/unified"
          >
            {split ? <Rows2 /> : <Columns2 />}
          </Button>
          {onEdit && (
            <Button
              variant="outline"
              size="2xs"
              className="nodrag"
              onClick={() => onEdit(file)}
              title="Edit this file in the editor"
            >
              <Pencil /> Edit
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon-2xs" className="nodrag" onClick={onClose} aria-label="close diff">
              <X />
            </Button>
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
          <Button
            size="xs"
            className="ml-auto"
            onClick={review.sendReview}
            title="Send all comments on this file to claude"
          >
            <Play fill="currentColor" strokeWidth={0} aria-hidden /> Send to Claude
          </Button>
          <Button variant="destructive" size="xs" onClick={review.clearFile} title="discard this file's comments">
            clear
          </Button>
        </div>
      )}
    </div>
  );
}
