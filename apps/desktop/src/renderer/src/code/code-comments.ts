/**
 * Comments on code in the editor (docs/design/code-windows-links-2026-11-25.md, step 2). Each open
 * file's state holds where its comments are, as positions that move with every change; one whose
 * lines are rewritten away is found again by its text, else it stays, outdated. What is stored
 * (lines on disk) is written back only when the editor matches the disk: after a save or a change
 * from disk.
 */
import { RangeSet, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { MAX_CODE_CONTEXT, MAX_CODE_TEXT, findCodeAnchor, type CodeAnchor, type CodeComment } from "@hivemind/core/review-shape";

export interface PlacedComment {
  comment: CodeComment;
  /** Start of its first line and end of its last, in the editor's text now. */
  from: number;
  to: number;
  /** Its lines are no longer in the file; it stays at `from`. */
  outdated: boolean;
}

/** The file's comments as the store has them now. */
export const setCodeComments = StateEffect.define<readonly CodeComment[]>();

const CONTEXT_LINES = 2;

/** The anchor for lines `startLine`..`endLine` of `doc`, read line by line. */
export function anchorIn(doc: Text, startLine: number, endLine: number): CodeAnchor {
  const start = Math.max(1, Math.min(startLine, doc.lines));
  const end = Math.max(start, Math.min(endLine, doc.lines));
  const span = (a: number, b: number): string => (a > b ? "" : doc.sliceString(doc.line(a).from, doc.line(b).to));
  return {
    startLine: start,
    endLine: end,
    text: span(start, end).slice(0, MAX_CODE_TEXT),
    before: span(Math.max(1, start - CONTEXT_LINES), start - 1).slice(0, MAX_CODE_CONTEXT),
    after: span(end + 1, Math.min(doc.lines, end + CONTEXT_LINES)).slice(0, MAX_CODE_CONTEXT),
  };
}

function linesSpan(doc: Text, startLine: number, endLine: number): { from: number; to: number } {
  const start = Math.max(1, Math.min(startLine, doc.lines));
  const end = Math.max(start, Math.min(endLine, doc.lines));
  return { from: doc.line(start).from, to: doc.line(end).to };
}

/** Where `c` is in `doc` (as `lines`): found by its text and neighbours, its stored lines first. */
function place(c: CodeComment, doc: Text, lines: () => string[]): PlacedComment {
  const found = findCodeAnchor(lines(), c);
  if (found) return { comment: c, ...linesSpan(doc, found.startLine, found.endLine), outdated: false };
  const at = linesSpan(doc, c.startLine, c.startLine).from;
  return { comment: c, from: at, to: at, outdated: true };
}

/** Through a change: its ends move with the text; when its lines went with the change it is found
 *  again by its text, else it is outdated where they were. The same object when nothing moved. */
export function mapPlaced(p: PlacedComment, changes: ChangeDesc, doc: Text): PlacedComment {
  if (p.outdated) {
    const at = changes.mapPos(p.from, 1);
    return at === p.from ? p : { ...p, from: at, to: at };
  }
  const from = changes.mapPos(p.from, 1);
  const to = changes.mapPos(p.to, -1);
  // A comment on one empty line spans nothing to begin with, and is lost only when its ends cross.
  if (p.to > p.from ? to > from : to >= from) return from === p.from && to === p.to ? p : { ...p, from: doc.lineAt(from).from, to: doc.lineAt(to).to };
  const found = findCodeAnchor(doc.toString().split("\n"), p.comment);
  if (found) return { ...p, ...linesSpan(doc, found.startLine, found.endLine) };
  const at = doc.lineAt(Math.min(from, doc.length)).from;
  return { ...p, from: at, to: at, outdated: true };
}

export const codeCommentsField = StateField.define<readonly PlacedComment[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.length) {
      const mapped = value.map((p) => mapPlaced(p, tr.changes, tr.newDoc));
      if (mapped.some((p, i) => p !== value[i])) next = mapped;
    }
    for (const e of tr.effects) {
      if (!e.is(setCodeComments)) continue;
      // One already placed keeps where the edits took it; a new one is placed by its stored lines.
      const was = new Map(next.map((p) => [p.comment.id, p]));
      let lines: string[] | null = null;
      const linesNow = () => (lines ??= tr.state.doc.toString().split("\n"));
      next = e.value.map((c) => {
        const kept = was.get(c.id);
        return kept && kept.comment.startLine === c.startLine && kept.comment.text === c.text ? { ...kept, comment: c } : place(c, tr.state.doc, linesNow);
      });
    }
    return next;
  },
});

/** Comments whose lines moved or changed since stored: what to store, read while the editor
 *  matches the disk. */
export function movedAnchors(state: EditorState): { id: string; to: CodeAnchor }[] {
  const doc = state.doc;
  const out: { id: string; to: CodeAnchor }[] = [];
  for (const p of state.field(codeCommentsField, false) ?? []) {
    if (p.outdated) continue;
    const to = anchorIn(doc, doc.lineAt(p.from).number, doc.lineAt(p.to).number);
    const c = p.comment;
    if (to.startLine !== c.startLine || to.endLine !== c.endLine || to.text !== c.text || to.before !== c.before || to.after !== c.after) out.push({ id: c.id, to });
  }
  return out;
}

/** The comments that start on the line at `pos`. */
export function commentsOnLine(state: EditorState, pos: number): PlacedComment[] {
  const line = state.doc.lineAt(pos).number;
  return (state.field(codeCommentsField, false) ?? []).filter((p) => state.doc.lineAt(p.from).number === line);
}

class CommentMark extends GutterMarker {
  constructor(readonly count: number, readonly outdated: boolean) { super(); }
  eq(other: CommentMark) { return other.count === this.count && other.outdated === this.outdated; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.outdated ? "cm-code-comment-mark cm-code-comment-outdated" : "cm-code-comment-mark";
    el.textContent = this.count > 1 ? String(this.count) : "";
    el.title = `${this.count} comment${this.count === 1 ? "" : "s"}${this.outdated ? ", outdated" : ""}: click to open`;
    el.setAttribute("data-code-comment-mark", "");
    return el;
  }
}

/** The gutter's width, unseen: a mark's size, but no comment of its own. */
class CommentSpace extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-code-comment-mark";
    return el;
  }
}

const theme = EditorView.baseTheme({
  ".cm-code-comments .cm-gutterElement": { padding: "0 2px", cursor: "pointer" },
  ".cm-code-comment-mark": {
    display: "inline-grid", placeItems: "center", minWidth: "8px", height: "8px", borderRadius: "999px",
    backgroundColor: "var(--color-brand)", color: "var(--color-bg)", fontSize: "var(--text-chip)", lineHeight: "1",
  },
  ".cm-code-comment-outdated": { backgroundColor: "var(--color-fg3)" },
});

/** Gutter marks on the first line of each comment; a click calls `onOpen` with that line's. */
export function codeComments(onOpen: (ids: string[], at: number) => void): Extension {
  return [
    codeCommentsField,
    theme,
    gutter({
      class: "cm-code-comments",
      markers: (view) => {
        const doc = view.state.doc;
        const byLine = new Map<number, { from: number; count: number; outdated: boolean }>();
        for (const p of view.state.field(codeCommentsField)) {
          const line = doc.lineAt(p.from);
          const was = byLine.get(line.number);
          byLine.set(line.number, { from: line.from, count: (was?.count ?? 0) + 1, outdated: (was?.outdated ?? true) && p.outdated });
        }
        const marks = [...byLine.values()].sort((a, b) => a.from - b.from).map((m) => new CommentMark(m.count, m.outdated).range(m.from));
        return RangeSet.of(marks);
      },
      initialSpacer: () => new CommentSpace(),
      domEventHandlers: {
        mousedown(view, line) {
          const here = commentsOnLine(view.state, line.from);
          if (!here.length) return false;
          onOpen(here.map((p) => p.comment.id), line.from);
          return true;
        },
      },
    }),
  ];
}
