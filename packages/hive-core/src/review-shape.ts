/** Review comments as data: what one is and where it is in its life, with nothing that reads a disk. */

export type ReviewSide = "deletions" | "additions";

export interface ReviewReply {
  author: string;
  body: string;
  at: string;
}

/** What the person wants done about it. */
export type ReviewIntent = "fix" | "change" | "question";
export const REVIEW_INTENTS: readonly ReviewIntent[] = ["fix", "change", "question"];

/** A box on a page, in CSS pixels from its top-left corner (scrolled content included). */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element a note points at, as the page showed it. */
export interface PageElement {
  /** How a person names it: its role and accessible name (`button "Save"`). */
  name: string;
  /** A CSS selector that matched this element alone when it was picked. */
  selector: string;
  /** Its own text, cut short. */
  text?: string;
  /** The text just before and after it. */
  nearby?: string;
  box: PageBox;
}

/** Where on a page a note points: elements picked there, or an area. */
export interface PageAnchor {
  url: string;
  title?: string;
  /** The page's visible size when the note was made. */
  viewport: { width: number; height: number };
  elements: PageElement[];
  /** A dragged area, when the note is on an area. */
  area?: PageBox;
  /** A picture of what it points at: a file in `pages/` beside review.json. */
  picture?: string;
}

export interface CommentFields {
  id: string;
  body: string;
  author: string;
  at: string;
  intent?: ReviewIntent;
  /** Closed: done, or dismissed when `dismissed` says so. */
  resolved?: boolean;
  dismissed?: boolean;
  /** An agent has read it and is on it; it is still open. */
  seen?: boolean;
  /** Set when closed: what was done, or why it was dismissed. */
  summary?: string;
  replies?: ReviewReply[];
}

/** A comment on lines of a diff. */
export interface DiffComment extends CommentFields {
  file: string;
  startLine: number;
  endLine: number;
  side: ReviewSide;
}

/** A comment on lines of a file as it is on disk, kept with the text it was about so it can be
 *  found again after the file changes; when it cannot be, it is outdated, never dropped. */
export interface CodeComment extends CommentFields {
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The lines it is about, as they were. */
  text: string;
  /** Up to two lines just above and just below them, as they were. */
  before: string;
  after: string;
}

/** A note on a page in a Browser tile. */
export interface PageComment extends CommentFields {
  page: PageAnchor;
  /** Proof kept on the note, videos or images: files in `pages/` beside review.json. */
  attachments?: string[];
}

/** Where on the board a note is pinned. */
export interface BoardAnchor {
  /** The tile, frame or object it is pinned to, which it follows; none: the canvas itself. */
  on?: string;
  /** From `on`'s corner, else on the canvas. */
  x: number;
  y: number;
  /** What it points at, in words: a box's text, a tile's name. */
  what?: string;
}

/** A note pinned on the board. */
export interface BoardComment extends CommentFields {
  board: BoardAnchor;
}

export type ReviewComment = DiffComment | CodeComment | PageComment | BoardComment;

export const onPage = (c: ReviewComment): c is PageComment => "page" in c;
export const onBoard = (c: ReviewComment): c is BoardComment => "board" in c;
export const onCode = (c: ReviewComment): c is CodeComment => "text" in c && !("page" in c) && !("board" in c);
export const onDiff = (c: ReviewComment): c is DiffComment => !("page" in c) && !("board" in c) && !("text" in c);

/** The author on what the person writes. Any other author is an agent, by its name. */
export const PERSON_AUTHOR = "you";
export const byAgent = (c: ReviewComment): boolean => c.author !== PERSON_AUTHOR;

/** Where a comment is in its life: open, seen (an agent is on it), resolved or dismissed. */
export type ReviewStatus = "open" | "seen" | "resolved" | "dismissed";

export function statusOf(c: ReviewComment): ReviewStatus {
  if (c.resolved) return c.dismissed ? "dismissed" : "resolved";
  return c.seen ? "seen" : "open";
}

/** Where a code comment points, and what it found there. */
export type CodeAnchor = Pick<CodeComment, "startLine" | "endLine" | "text" | "before" | "after">;

const CONTEXT_LINES = 2;

/** What a code comment keeps of its lines, and of the lines around them. */
export const MAX_CODE_TEXT = 100_000;
export const MAX_CODE_CONTEXT = 2000;

/** The anchor for lines `startLine`..`endLine` (1-based) of `lines`. */
export function anchorAt(lines: readonly string[], startLine: number, endLine: number): CodeAnchor {
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  return {
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join("\n").slice(0, MAX_CODE_TEXT),
    before: lines.slice(Math.max(0, start - 1 - CONTEXT_LINES), start - 1).join("\n").slice(0, MAX_CODE_CONTEXT),
    after: lines.slice(end, end + CONTEXT_LINES).join("\n").slice(0, MAX_CODE_CONTEXT),
  };
}

const linesOf = (s: string): string[] => (s === "" ? [] : s.split("\n"));
const matchesAt = (lines: readonly string[], want: readonly string[], at: number): boolean =>
  at >= 0 && at + want.length <= lines.length && want.every((w, k) => lines[at + k] === w);
const hasWords = (want: readonly string[]): boolean => want.some((l) => l.trim() !== "");

/**
 * Where a comment's lines are in `lines` now (1-based), or null when they are gone: outdated.
 * Its own text found again with at least one neighbour the same, the place whose neighbours match
 * best and that is nearest wins; else the lines between its unchanged neighbours above and below,
 * when its own were edited. Text alone is not enough: a `}` deleted is not the next `}`. When one
 * side has words, a blank side is no evidence.
 */
export function findCodeAnchor(lines: readonly string[], a: CodeAnchor): { startLine: number; endLine: number } | null {
  const want = linesOf(a.text);
  const before = linesOf(a.before);
  const after = linesOf(a.after);
  if (want.length > 0) {
    const anyWords = hasWords(before) || hasWords(after);
    const counts = (side: readonly string[]) => !anyWords || hasWords(side);
    let best: { at: number; score: number } | null = null;
    for (let i = 0; i + want.length <= lines.length; i++) {
      if (!matchesAt(lines, want, i)) continue;
      const context = (counts(before) && matchesAt(lines, before, i - before.length) ? 1 : 0) + (counts(after) && matchesAt(lines, after, i + want.length) ? 1 : 0);
      if (context === 0) continue;
      const score = context * 1e9 - Math.abs(i + 1 - a.startLine);
      if (!best || score > best.score) best = { at: i, score };
    }
    if (best) return { startLine: best.at + 1, endLine: best.at + want.length };
  }
  if (!hasWords(before) || !hasWords(after)) return null;
  // Edited in place: the neighbours are still there with lines between them, not too many more.
  const most = want.length * 4 + 20;
  let found: { startLine: number; endLine: number; off: number } | null = null;
  for (let p = 0; p + before.length <= lines.length; p++) {
    if (!matchesAt(lines, before, p)) continue;
    const start = p + before.length;
    // Its neighbours meet: its lines were deleted.
    if (matchesAt(lines, after, start)) continue;
    for (let q = start + 1; q <= Math.min(lines.length - after.length, start + most); q++) {
      if (!matchesAt(lines, after, q)) continue;
      const off = Math.abs(start + 1 - a.startLine);
      if (!found || off < found.off) found = { startLine: start + 1, endLine: q, off };
      break;
    }
  }
  return found ? { startLine: found.startLine, endLine: found.endLine } : null;
}

/** How a person or an agent names a code comment's lines: `@src/a.ts#L5-10`. */
export const codeRef = (c: Pick<CodeComment, "file" | "startLine" | "endLine">): string =>
  `@${c.file}#L${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`;

const fenceFor = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
};

/** One code comment as an agent reads it: where, what is asked, the lines it is about, the thread. */
export function codeCommentText(c: CodeComment, unsaved = false): string {
  const fence = fenceFor(c.text);
  return [
    `${c.id}${c.intent ? ` (${c.intent})` : ""}: ${codeRef(c)}${unsaved ? " (unsaved: lines as the editor has them; on disk find them by the text below)" : ""}`,
    c.body,
    fence,
    c.text,
    fence,
    ...(c.replies ?? []).map((r) => `  ↳ ${r.author}: ${r.body}`),
  ].join("\n");
}

/** Comments on code as one message to an agent, with how to answer them. `unsaved`: the comment's
 *  file has edits not on disk, so its line numbers are the editor's. */
export function codeCommentsMessage(list: readonly CodeComment[], unsaved: (c: CodeComment) => boolean = () => false): string {
  const n = list.length;
  const change = list.some((c) => c.intent === "change");
  return [
    `${n} comment${n === 1 ? "" : "s"} on code to address:`,
    "",
    ...list.flatMap((c) => [codeCommentText(c, unsaved(c)), ""]),
    "Answer each in its thread with `hive review reply <id> \"…\"`, and close it with `hive review resolve <id> --summary \"…\"`.",
    ...(change ? ["Make a change in the file itself: the person's editor shows it as it lands."] : []),
  ].join("\n");
}
