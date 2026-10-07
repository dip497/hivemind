/**
 * What people write in a board object, as every kind that has it edits it: a checklist's title and
 * lines (ticked, added with Enter, removed with Backspace on an empty one, dragged to reorder). A
 * checklist uses it, and so does any widget whose drawing has a list, so both edit the same way.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, GripVertical, Plus } from "lucide-react";
import type { ChecklistItem } from "@hivemind/workspace-doc/shapes";
import { mintId } from "@hivemind/workspace-api/tile-id";
import { useBoardContext } from "./board-context";
import { TextLine } from "./TextDraft";

/** Where a dragged item lands: past every other row whose middle is above the pointer. */
function dropIndex(list: HTMLElement | null, from: number, clientY: number): number {
  const rows = [...(list?.children ?? [])] as HTMLElement[];
  return rows.filter((row, i) => {
    if (i === from) return false;
    const b = row.getBoundingClientRect();
    return b.top + b.height / 2 < clientY;
  }).length;
}

/** A title line and its lines, edited in place while `editing`. */
export function ChecklistFields({ id, object, editing, selected, setText, setItems, title = true, placeholder = "Checklist" }: {
  id: string;
  object: { text?: string; items?: ChecklistItem[] };
  editing: boolean;
  selected: boolean;
  setText: (edit: (now: string) => string) => void;
  setItems: (change: (items: ChecklistItem[]) => ChecklistItem[]) => void;
  /** Whether it has a title line above its lines. */
  title?: boolean;
  placeholder?: string;
}) {
  const board = useBoardContext();
  const items = object.items ?? [];
  // The line a keypress just made or left, to write in next: null is the title.
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const addAfter = (index: number) => {
    const item = { id: mintId("item"), text: "", done: false };
    setItems((all) => [...all.slice(0, index + 1), item, ...all.slice(index + 1)]);
    setFocusLine(item.id);
    board.edit(id);
  };
  const gripDown = (index: number) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: index, to: index });
  };
  const gripMove = (e: ReactPointerEvent) => {
    if (drag) setDrag({ from: drag.from, to: dropIndex(listRef.current, drag.from, e.clientY) });
  };
  const gripUp = () => {
    if (drag && drag.to !== drag.from) {
      setItems((all) => {
        const next = [...all];
        const [moved] = next.splice(drag.from, 1);
        next.splice(drag.to, 0, moved!);
        return next;
      });
    }
    setDrag(null);
  };
  return <>
    {title && (editing
      ? <TextLine value={object.text ?? ""} of={object} autoFocus={focusLine === null} aria-label="checklist title" placeholder={placeholder}
          className="text-[13px] font-semibold"
          onCommit={setText}
          onKey={(e, commit) => {
            if (e.key !== "Enter") return false;
            e.preventDefault();
            commit();
            addAfter(-1);
            return true;
          }} />
      : <div className="truncate text-[13px] font-semibold" data-board-text>{object.text || <span className="opacity-50">{placeholder}</span>}</div>)}
    <ul ref={listRef} className="nowheel flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
      {items.map((item, index) => (
        <li key={item.id} data-checklist-item={item.id}
          className={`flex items-center gap-1.5 rounded px-0.5 ${drag?.to === index && drag.from !== index ? "bg-[var(--color-bg4)]" : ""}`}>
          <span aria-hidden className="nodrag nopan cursor-grab text-[var(--color-fg3)] active:cursor-grabbing"
            onPointerDown={gripDown(index)} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={() => setDrag(null)}>
            <GripVertical className="size-3" />
          </span>
          <button type="button" role="checkbox" aria-checked={item.done} aria-label={item.text || "item"}
            className="nodrag nopan grid size-3.5 shrink-0 place-items-center rounded-sm border border-[var(--color-line2)] bg-[var(--color-bg2)]"
            onClick={() => setItems((all) => all.map((it) => (it.id === item.id ? { ...it, done: !it.done } : it)))}>
            {item.done && <Check className="size-3" />}
          </button>
          {editing
            ? <TextLine value={item.text} of={item} autoFocus={focusLine === item.id} aria-label="item" className="flex-1 text-[13px]"
                onCommit={(edit) => setItems((all) => all.map((it) => (it.id === item.id ? { ...it, text: edit(it.text) } : it)))}
                onKey={(e, commit) => {
                  if (e.key === "Enter") { e.preventDefault(); commit(); addAfter(index); return true; }
                  if (e.key === "Backspace" && e.currentTarget.value === "") {
                    e.preventDefault();
                    setItems((all) => all.filter((it) => it.id !== item.id));
                    setFocusLine(index > 0 ? items[index - 1]!.id : null);
                    return true;
                  }
                  return false;
                }} />
            : <span className={`flex-1 truncate text-[13px]${item.done ? " text-[var(--color-fg3)] line-through" : ""}`}>{item.text}</span>}
        </li>
      ))}
    </ul>
    {(selected || editing) && (
      <button type="button" className="nodrag nopan flex items-center gap-1 self-start text-[12px] text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
        onClick={() => addAfter(items.length - 1)}>
        <Plus className="size-3" />Add item
      </button>
    )}
  </>;
}
