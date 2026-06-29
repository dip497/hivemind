/**
 * Pure data model + migration for DiffTile review comments. Kept separate from
 * DiffTile.tsx (which pulls in the whole Pierre/React tree) so it's unit-testable
 * in isolation. `AnnotationSide` is a type-only import → erased at runtime.
 */
import type { AnnotationSide } from "@pierre/diffs";

export interface ReviewReply { author: string; body: string; at: string; }

/** A review comment spans [startLine, endLine] (equal for a single line). */
export interface ReviewComment {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  side: AnnotationSide;
  body: string;
  author: string;
  at: string;
  resolved?: boolean;
  replies?: ReviewReply[];
}

/** Old single-line shape persisted before ranges/threads landed. */
type LegacyComment = { file: string; line: number; side: AnnotationSide; body: string; author: string; at: string };

let cidSeq = 0;
export const newCid = (): string => `c-${Date.now().toString(36)}-${(cidSeq++).toString(36)}`;

const rangeStr = (c: ReviewComment): string =>
  c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;

/** One comment → the message sent to claude ("Address this review comment …"). */
export function formatCommentMessage(c: ReviewComment): string {
  const thread = [c.body, ...(c.replies ?? []).map((r) => `  ↳ ${r.author}: ${r.body}`)].join("\n");
  return `Address this review comment — ${c.file}:${rangeStr(c)}:\n${thread}`;
}

/** A batch of comments → one review message (unresolved only). null if none. */
export function formatReviewMessage(comments: ReviewComment[]): string | null {
  const open = comments.filter((c) => !c.resolved);
  if (open.length === 0) return null;
  const lines = open
    .map((c) => {
      const side = c.side === "deletions" ? "old/left" : "new/right";
      const thread = (c.replies ?? []).map((r) => ` ↳ ${r.author}: ${r.body}`).join("\n");
      return `- ${c.file}:${rangeStr(c)} (${side}): ${c.body}${thread ? "\n" + thread : ""}`;
    })
    .join("\n");
  return `Code review — ${open.length} unresolved comment${open.length > 1 ? "s" : ""} to address:\n${lines}`;
}

/** Migrate persisted comments (old single-line → range) so existing reviews
 *  survive the upgrade. Tolerant of garbage input → []. */
export function normalizeComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c): ReviewComment => {
    const o = c as Partial<ReviewComment> & Partial<LegacyComment>;
    const start = o.startLine ?? o.line ?? 1;
    const end = o.endLine ?? o.line ?? start;
    return {
      id: o.id ?? newCid(),
      file: o.file ?? "",
      startLine: start,
      endLine: end,
      side: (o.side ?? "additions") as AnnotationSide,
      body: o.body ?? "",
      author: o.author ?? "you",
      at: o.at ?? "",
      resolved: o.resolved ?? false,
      replies: o.replies ?? [],
    };
  });
}
