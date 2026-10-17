/**
 * Writing in a board object: the text is a draft here while you type, and reaches the board when
 * you stop for a moment, leave the field or ask to undo, so a keystroke re-renders this field
 * alone. What the board holds replaces the draft whenever the draft has nothing unsaved and the
 * board is read again (an undo, a redo, someone else's writing). What reaches the board is what
 * was typed here, made to the text as the board holds it then (`mergeText`, from the text the
 * draft began with): someone else writing in the same text meanwhile keeps their words (§4.4). ⌘Z and ⌘⇧Z are the board's here, not the field's own, so
 * they take back what you typed the way they take back every other board edit. Leaving the object
 * ends the writing.
 *
 * A field asked to take focus takes it as it mounts, before the next key arrives, and keeps
 * trying for a few frames if it could not (a node react-flow has not shown yet): a key typed
 * before it has focus would be lost, or be a canvas shortcut.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { mergeText } from "@hivemind/workspace-doc/text-merge";
import { useBoardContext } from "./board-context";

const IDLE_MS = 400;
const FOCUS_FRAMES = 10;

interface DraftProps {
  value: string;
  /** What `value` was read from (the object, the item): a new one is a new reading of the board. */
  of: object;
  /** What was typed: given the text as it is now, the text with it made. */
  onCommit: (edit: (now: string) => string) => void;
  /** Keys the field handles before the defaults: return true when handled. */
  onKey?: (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, commit: () => void) => boolean;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  "aria-label": string;
}

function useDraft<E extends HTMLTextAreaElement | HTMLInputElement>({ value, of, onCommit, onKey, autoFocus }: Pick<DraftProps, "value" | "of" | "onCommit" | "onKey" | "autoFocus">) {
  const board = useBoardContext();
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  /** The text the draft began with: what was typed is the change from it. */
  const began = useRef(value);
  const ref = useRef<E>(null);
  // On `of`, not only `value`: undoing what was typed here gives back the very text last shown,
  // and the draft still holds what was typed.
  useEffect(() => {
    if (dirty.current) return;
    setDraft(value);
    began.current = value;
  }, [value, of]);
  useLayoutEffect(() => {
    if (!autoFocus) return undefined;
    let frame = 0;
    let tries = 0;
    const take = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el && ++tries < FOCUS_FRAMES) frame = requestAnimationFrame(take);
    };
    take();
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const commitRef = useRef(() => {});
  commitRef.current = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const [from, typed] = [began.current, draft];
    onCommit((now) => mergeText(from, typed, now));
    began.current = typed;
  };
  useEffect(() => {
    if (!dirty.current) return undefined;
    const t = setTimeout(() => commitRef.current(), IDLE_MS);
    return () => clearTimeout(t);
  }, [draft]);
  // Unmounted with a draft still unsaved (the object left, deleted, undone): save it first.
  useEffect(() => () => commitRef.current(), []);
  const commit = () => commitRef.current();
  return {
    ref,
    value: draft,
    onChange: (e: { target: { value: string } }) => { dirty.current = true; setDraft(e.target.value); },
    onBlur: (e: FocusEvent<E>) => {
      commit();
      // Focus moving within the object (a checklist's next line) keeps it being written in.
      const home = e.currentTarget.closest("[data-board-object], [data-arrow-label]");
      const next = e.relatedTarget as Node | null;
      if (!next || !home?.contains(next)) board.edit(null);
    },
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (onKey?.(e, commit)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        e.preventDefault();
        e.stopPropagation();
        commit();
        if (key === "y" || e.shiftKey) board.redo();
        else board.undo();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commit();
        board.edit(null);
      }
    },
  };
}

/** A multi-line field: a note's text, a label's. */
export function TextArea(props: DraftProps) {
  const draft = useDraft<HTMLTextAreaElement>(props);
  return <textarea {...draft} placeholder={props.placeholder} aria-label={props["aria-label"]}
    className={`nodrag nopan nowheel resize-none bg-transparent outline-none ${props.className ?? ""}`} style={props.style} />;
}

/** A one-line field: a checklist's title, an item, an arrow's label. */
export function TextLine(props: DraftProps) {
  const draft = useDraft<HTMLInputElement>(props);
  return <input {...draft} placeholder={props.placeholder} aria-label={props["aria-label"]}
    className={`nodrag nopan min-w-0 bg-transparent outline-none ${props.className ?? ""}`} style={props.style} />;
}
