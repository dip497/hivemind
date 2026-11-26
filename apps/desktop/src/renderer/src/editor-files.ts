/**
 * The files open in a Code tile. Each keeps its own editor state, so a tab keeps its undo, cursor
 * and scroll across switches; the text last read or saved, as the editor holds it, which "unsaved"
 * compares against; and the file's line ending, which saving writes back.
 */
import { EditorState, Text, type ChangeSpec, type Extension, type StateEffect, type Transaction, type TransactionSpec } from "@codemirror/state";

export type LineEnding = "\n" | "\r\n";

/** A file's line ending is its first line's. */
export function lineEndingOf(text: string): LineEnding {
  const at = text.indexOf("\n");
  return at > 0 && text[at - 1] === "\r" ? "\r\n" : "\n";
}

/** The smallest change that turns `doc` into `text` (as on disk): what both start and end with stays,
 *  so the cursor, the scroll and the undo history outside the changed part do too. Null when equal. */
export function changeTo(doc: Text, text: string): ChangeSpec | null {
  const now = doc.toString();
  const next = text.replace(/\r\n?/g, "\n");
  if (now === next) return null;
  const most = Math.min(now.length, next.length);
  let start = 0;
  while (start < most && now.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < most - start && now.charCodeAt(now.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  return { from: start, to: now.length - end, insert: next.slice(start, next.length - end) };
}

export interface OpenFile {
  state: EditorState;
  /** The text last read or saved. Shares the state's tree, so comparing costs the changed part only. */
  saved: Text;
  ending: LineEnding;
  /** Where it was scrolled to when another file took the editor. */
  scroll: StateEffect<unknown> | null;
}

/** What `OpenFiles` needs of the editor that shows one file at a time. */
export interface FileView {
  state: EditorState;
  setState(state: EditorState): void;
  dispatch(tr: Transaction): void;
  scrollSnapshot(): StateEffect<unknown>;
}

export class OpenFiles {
  private files = new Map<string, OpenFile>();
  /** The file whose state the view holds, which is not the active tab while that one loads. */
  private shown: string | null = null;

  /** Open `path` with its text from disk. */
  open(path: string, disk: string, extensions: Extension): OpenFile {
    const state = EditorState.create({ doc: disk, extensions });
    const file: OpenFile = { state, saved: state.doc, ending: lineEndingOf(disk), scroll: null };
    this.files.set(path, file);
    return file;
  }

  has(path: string): boolean { return this.files.has(path); }
  shownPath(): string | null { return this.shown; }

  /** The file's state as it is now: the view's while it shows it. */
  stateOf(path: string, view: FileView | null): EditorState | null {
    if (path === this.shown && view) return view.state;
    return this.files.get(path)?.state ?? null;
  }

  /** Show `path` in `view`; the file shown before keeps its state and scroll. */
  show(path: string, view: FileView): boolean {
    const next = this.files.get(path);
    if (!next) return false;
    if (this.shown === path) return true;
    this.keepShown(view);
    view.setState(next.state);
    if (next.scroll) view.dispatch(next.state.update({ effects: next.scroll }));
    this.shown = path;
    return true;
  }

  unsaved(path: string, view: FileView | null): boolean {
    const file = this.files.get(path);
    const state = this.stateOf(path, view);
    return !!file && !!state && !state.doc.eq(file.saved);
  }

  /** What saving writes: the editor's text with the file's own line ending, and the text to mark saved. */
  toSave(path: string, view: FileView | null): { text: string; doc: Text } | null {
    const file = this.files.get(path);
    const state = this.stateOf(path, view);
    if (!file || !state) return null;
    return { text: state.doc.sliceString(0, state.doc.length, file.ending), doc: state.doc };
  }

  markSaved(path: string, doc: Text): void {
    const file = this.files.get(path);
    if (file) file.saved = doc;
  }

  /**
   * The file changed on disk to `disk`. Without unsaved edits the change is applied as the smallest
   * edit ("applied"); with them nothing is touched ("conflict"); "same" when the editor already
   * holds it, or it is what was last saved (a save of our own, typed past since). `force` applies
   * it over unsaved edits (Reload).
   */
  fromDisk(path: string, disk: string, view: FileView | null, force = false): "same" | "applied" | "conflict" {
    const file = this.files.get(path);
    const state = this.stateOf(path, view);
    if (!file || !state) return "same";
    file.ending = lineEndingOf(disk);
    const change = changeTo(state.doc, disk);
    if (!change) {
      file.saved = state.doc;
      return "same";
    }
    if (!force && !state.doc.eq(file.saved)) return changeTo(file.saved, disk) ? "conflict" : "same";
    const tr = state.update({ changes: change });
    // Set before the view runs its listeners, so this reads as saved, not as an edit.
    file.saved = tr.newDoc;
    if (path === this.shown && view) view.dispatch(tr);
    else file.state = tr.state;
    return "applied";
  }

  /** Apply `spec` to the file's state, shown or not. */
  update(path: string, view: FileView | null, spec: TransactionSpec): void {
    const file = this.files.get(path);
    if (!file) return;
    if (path === this.shown && view) view.dispatch(view.state.update(spec));
    else file.state = file.state.update(spec).state;
  }

  /** Forget files no longer open. */
  keepOnly(paths: Iterable<string>, view: FileView | null): void {
    const open = new Set(paths);
    for (const path of [...this.files.keys()]) {
      if (open.has(path)) continue;
      if (path === this.shown) {
        if (view) this.keepShown(view);
        this.shown = null;
      }
      this.files.delete(path);
    }
  }

  private keepShown(view: FileView): void {
    const was = this.shown ? this.files.get(this.shown) : undefined;
    if (!was) return;
    was.state = view.state;
    was.scroll = view.scrollSnapshot();
  }
}
