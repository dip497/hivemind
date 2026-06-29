/**
 * useReviewComments — inline diff review (comments + send-to-Claude) for a SINGLE
 * file, used by the Code Workbench's Pierre diff. Owns only the per-file STATE +
 * line-interaction wiring; all the shared LEAVES are reused, not copied:
 *   • persistence + deliver → code/review-store (same key as DiffTile)
 *   • message formatting     → diff-comments (formatReviewMessage)
 *   • annotation card + anchor + composer → review-ui (ReviewAnnotation,
 *     composerAnchor, ReviewPopover/CommentBox/ActionToolbar)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AnnotationSide, DiffLineAnnotation } from "@pierre/diffs";
import { ReviewPopover, CommentBox, ActionToolbar, ReviewAnnotation, composerAnchor } from "../review-ui";
import { newCid, formatReviewMessage, type ReviewComment } from "../diff-comments";
import { loadComments, saveComments, deliverToClaude } from "./review-store";

type Composer = {
  startLine: number; endLine: number; side: AnnotationSide;
  anchor: { x: number; y: number }; stage: "choose" | "comment";
};

export function useReviewComments(repoPath: string, file: string | null) {
  const [comments, setComments] = useState<ReviewComment[]>(() => loadComments(repoPath));
  useEffect(() => { setComments(loadComments(repoPath)); }, [repoPath]);
  const persist = useCallback((next: ReviewComment[]) => {
    setComments(next);
    saveComments(repoPath, next);
  }, [repoPath]);

  // Attach to the diff's scroll container so the composer anchors under the line.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => { if (!composer) setDraft(""); }, [composer]);

  const openComposerAt = useCallback(
    (startLine: number, endLine: number, side: AnnotationSide, lineEl: HTMLElement | null) => {
      setComposer({ startLine, endLine, side, anchor: composerAnchor(hostRef.current, lineEl), stage: "choose" });
    },
    [],
  );

  const lineAnnotations: DiffLineAnnotation<ReviewComment>[] = file
    ? comments.filter((c) => c.file === file).map((c) => ({ side: c.side, lineNumber: c.endLine, metadata: c }))
    : [];

  const renderAnnotation = useCallback(
    (a: DiffLineAnnotation<ReviewComment>) => <ReviewAnnotation comment={a.metadata} />,
    [],
  );

  const submit = useCallback((body: string) => {
    if (!composer || !file || !body.trim()) { setComposer(null); return; }
    persist([
      ...comments,
      {
        id: newCid(),
        file,
        startLine: composer.startLine,
        endLine: composer.endLine,
        side: composer.side,
        body,
        author: "you",
        at: new Date().toISOString().slice(0, 16).replace("T", " "),
        resolved: false,
        replies: [],
      },
    ]);
    setComposer(null);
  }, [composer, file, comments, persist]);

  // Pierre line-interaction callbacks for the diff `options`.
  const onGutterUtilityClick = useCallback(
    (range: { start: number; end: number; side?: AnnotationSide; endSide?: AnnotationSide }) => {
      const side = range.side ?? range.endSide ?? "additions";
      openComposerAt(Math.min(range.start, range.end), Math.max(range.start, range.end), side, null);
    },
    [openComposerAt],
  );
  const onLineNumberClick = useCallback(
    (p: { lineNumber?: number; annotationSide?: AnnotationSide; lineElement?: HTMLElement }) => {
      if (p.lineNumber == null) return;
      openComposerAt(p.lineNumber, p.lineNumber, p.annotationSide ?? "additions", p.lineElement ?? null);
    },
    [openComposerAt],
  );

  const fileComments = file ? comments.filter((c) => c.file === file) : [];
  const clearFile = useCallback(() => { if (file) persist(comments.filter((c) => c.file !== file)); }, [comments, file, persist]);

  // Send THIS file's unresolved comments to claude as one message.
  const sendReview = useCallback(() => {
    const msg = formatReviewMessage(fileComments);
    if (msg) deliverToClaude(msg);
  }, [fileComments]);

  const composerNode: ReactNode = composer && file ? (
    <ReviewPopover anchor={composer.anchor} onClose={() => setComposer(null)}>
      {composer.stage === "choose" ? (
        <ActionToolbar
          onComment={() => setComposer({ ...composer, stage: "comment" })}
          onQuickLabel={(label, tip) => submit(tip ? `**${label}** — ${tip}` : label)}
        />
      ) : (
        <CommentBox
          value={draft}
          onChange={setDraft}
          onCancel={() => setComposer({ ...composer, stage: "choose" })}
          onSubmit={() => submit(draft)}
        />
      )}
    </ReviewPopover>
  ) : null;

  return {
    hostRef,
    lineAnnotations,
    renderAnnotation,
    onGutterUtilityClick,
    onLineNumberClick,
    composerNode,
    sendReview,
    clearFile,
    count: fileComments.length,
  };
}
