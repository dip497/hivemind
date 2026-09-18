/**
 * Walking a diff's hunks to find things: every line matching a query, and one
 * anchor per hunk for next/prev-change navigation. Both walks map hunkContent
 * block indices back to real line numbers + side.
 */
import type { AnnotationSide, CodeViewDiffItem } from "@pierre/diffs";
import type { ReviewComment } from "../diff-comments";

export function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export interface SearchMatch {
  id: string;
  file: string;
  line: number;
  side: AnnotationSide;
}

/** Collect every line-level match across all diff items, mapping hunkContent
 *  block indices back to real line numbers + side (port of codiff's
 *  getDiffSearchResult). Lets us scrollTo + highlight each hit precisely. */
/** One anchor per HUNK (its first changed line) across every diff item, in file
 *  order — the jump targets for next/prev-change navigation. Prefers the addition
 *  side (the new code); a pure-deletion hunk anchors on its first deleted line.
 *  Same hunk-walk as collectMatches, but keyed on "is a change" rather than a query. */
export function collectChanges(items: CodeViewDiffItem<ReviewComment>[]): SearchMatch[] {
  const out: SearchMatch[] = [];
  for (const it of items) {
    const fd = it.fileDiff;
    for (const hunk of fd.hunks) {
      let del = hunk.deletionStart;
      let add = hunk.additionStart;
      for (const c of hunk.hunkContent) {
        if (c.type === "context") { del += c.lines; add += c.lines; continue; }
        // First non-context block = the hunk's anchor. Then stop (one per hunk).
        if (c.additions > 0) out.push({ id: it.id, file: fd.name, line: add, side: "additions" });
        else out.push({ id: it.id, file: fd.name, line: del, side: "deletions" });
        break;
      }
    }
  }
  return out;
}

export function collectMatches(items: CodeViewDiffItem<ReviewComment>[], query: string): SearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchMatch[] = [];
  for (const it of items) {
    const fd = it.fileDiff;
    for (const hunk of fd.hunks) {
      let del = hunk.deletionStart;
      let add = hunk.additionStart;
      for (const c of hunk.hunkContent) {
        if (c.type === "context") {
          for (let i = 0; i < c.lines; i++) {
            if ((fd.additionLines[c.additionLineIndex + i] ?? "").toLowerCase().includes(q))
              out.push({ id: it.id, file: fd.name, line: add + i, side: "additions" });
          }
          del += c.lines;
          add += c.lines;
        } else {
          for (let i = 0; i < c.deletions; i++) {
            if ((fd.deletionLines[c.deletionLineIndex + i] ?? "").toLowerCase().includes(q))
              out.push({ id: it.id, file: fd.name, line: del + i, side: "deletions" });
          }
          for (let i = 0; i < c.additions; i++) {
            if ((fd.additionLines[c.additionLineIndex + i] ?? "").toLowerCase().includes(q))
              out.push({ id: it.id, file: fd.name, line: add + i, side: "additions" });
          }
          del += c.deletions;
          add += c.additions;
        }
      }
    }
  }
  return out;
}
