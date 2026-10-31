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

/** A note on a page in a Browser tile. */
export interface PageComment extends CommentFields {
  page: PageAnchor;
}

export type ReviewComment = DiffComment | PageComment;

export const onPage = (c: ReviewComment): c is PageComment => "page" in c;
export const onDiff = (c: ReviewComment): c is DiffComment => !("page" in c);

/** Where a comment is in its life: open, seen (an agent is on it), resolved or dismissed. */
export type ReviewStatus = "open" | "seen" | "resolved" | "dismissed";

export function statusOf(c: ReviewComment): ReviewStatus {
  if (c.resolved) return c.dismissed ? "dismissed" : "resolved";
  return c.seen ? "seen" : "open";
}
