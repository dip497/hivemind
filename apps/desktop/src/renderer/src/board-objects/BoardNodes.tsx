/**
 * The board's boxes on the canvas (docs/design/multiplayer-2026-09-28.md, R15, §4.2 G): sticky
 * notes, text labels and checklists, drawn by plain React — no TileHost surface, no session. A
 * click selects one, a double-click writes in it; a selected one shows its resize handles and a
 * small bar (colour, duplicate, delete). Node data is the object alone; every edit goes through
 * the board (BoardContext).
 */
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { NodeResizer, type NodeTypes } from "@xyflow/react";
import { Check, Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import type { ChecklistItem, ChecklistObject, NoteObject, TextObject } from "@hivemind/workspace-doc/shapes";
import { Button } from "../components/ui/button";
import { mintId } from "../../../shared/tile-id";
import { BOX_SIZE, NOTE_COLORS, type BoxObject, type NoteColor } from "./board-model";
import { useBoardContext } from "./board-context";
import { TextArea, TextLine } from "./TextDraft";

interface BoxNodeProps<T extends BoxObject> {
  id: string;
  data: { object: T };
  selected?: boolean;
}

const HANDLE = { width: 10, height: 10, borderRadius: 3, border: "2px solid var(--color-bg)" } as const;

function noteColor(color: string | undefined): NoteColor {
  return (NOTE_COLORS as readonly string[]).includes(color ?? "") ? (color as NoteColor) : NOTE_COLORS[0];
}

function BoxShell({ id, object, selected, children }: { id: string; object: BoxObject; selected: boolean; children: ReactNode }) {
  const board = useBoardContext();
  const editing = board.editingId === id;
  const size = BOX_SIZE[object.kind];
  return (
    // nopan: a double-click here writes in the box instead of zooming the canvas.
    <div data-board-object={object.kind} className={`nopan relative h-full w-full${selected ? " hm-board-selected" : ""}`}
      onDoubleClick={() => { if (!editing) board.edit(id); }}>
      <NodeResizer nodeId={id} isVisible={selected && !editing} minWidth={size.minW} minHeight={size.minH}
        color="var(--color-select)" handleStyle={HANDLE}
        onResizeEnd={(_e, p) => board.resize(id, p.width, p.height, p.x, p.y)} />
      {selected && !editing && <BoxBar id={id} object={object} />}
      {children}
    </div>
  );
}

function BoxBar({ id, object }: { id: string; object: BoxObject }) {
  const board = useBoardContext();
  return (
    <div className="nodrag nopan hm-island absolute -top-10 left-0 flex items-center gap-1 rounded-lg p-1" data-board-bar>
      {object.kind === "note" && NOTE_COLORS.map((c) => (
        <button key={c} type="button" aria-label={`${c} note`} aria-pressed={noteColor(object.color) === c} data-note-color={c}
          className={`size-5 rounded-full border-2 ${noteColor(object.color) === c ? "border-[var(--color-fg)]" : "border-transparent"}`}
          style={{ background: `var(--color-note-${c})` }}
          onClick={() => board.update(id, (o) => (o.kind === "note" ? { ...o, color: c } : o))} />
      ))}
      <Button variant="ghost" size="icon-sm" aria-label="duplicate" title="Duplicate  (⌘D)" onClick={() => board.duplicate(id)}><Copy /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="delete" title="Delete  (⌫)" onClick={() => board.remove(id)}><Trash2 /></Button>
    </div>
  );
}

const NoteNode = memo(function NoteNode({ id, data, selected }: BoxNodeProps<NoteObject>) {
  const board = useBoardContext();
  const o = data.object;
  const editing = board.editingId === id;
  return (
    <BoxShell id={id} object={o} selected={!!selected}>
      <div className="h-full w-full rounded-md p-3 shadow-[var(--hm-shadow-2)]"
        style={{ background: `var(--color-note-${noteColor(o.color)})`, color: "var(--color-note-ink)" }}>
        {editing
          ? <TextArea value={o.text} of={o} autoFocus aria-label="note text" placeholder="Write something"
              className="h-full w-full text-[14px] leading-snug placeholder:opacity-50"
              onCommit={(text) => board.update(id, (x) => (x.kind === "note" ? { ...x, text } : x))} />
          : <div className="h-full w-full overflow-hidden whitespace-pre-wrap break-words text-[14px] leading-snug" data-board-text>
              {o.text || <span className="opacity-50">Write something</span>}
            </div>}
      </div>
    </BoxShell>
  );
});

const TextNode = memo(function TextNode({ id, data, selected }: BoxNodeProps<TextObject>) {
  const board = useBoardContext();
  const o = data.object;
  const editing = board.editingId === id;
  return (
    <BoxShell id={id} object={o} selected={!!selected}>
      <div className="h-full w-full px-1 text-[var(--color-fg)]">
        {editing
          ? <TextArea value={o.text} of={o} autoFocus aria-label="text" placeholder="Text"
              className="h-full w-full text-[20px] font-semibold leading-tight placeholder:opacity-50"
              onCommit={(text) => board.update(id, (x) => (x.kind === "text" ? { ...x, text } : x))} />
          : <div className="h-full w-full overflow-hidden whitespace-pre-wrap break-words text-[20px] font-semibold leading-tight" data-board-text>
              {o.text || <span className="opacity-50">Text</span>}
            </div>}
      </div>
    </BoxShell>
  );
});

/** Where a dragged item lands: past every other row whose middle is above the pointer. */
function dropIndex(list: HTMLElement | null, from: number, clientY: number): number {
  const rows = [...(list?.children ?? [])] as HTMLElement[];
  return rows.filter((row, i) => {
    if (i === from) return false;
    const b = row.getBoundingClientRect();
    return b.top + b.height / 2 < clientY;
  }).length;
}

const ChecklistNode = memo(function ChecklistNode({ id, data, selected }: BoxNodeProps<ChecklistObject>) {
  const board = useBoardContext();
  const o = data.object;
  const editing = board.editingId === id;
  // The line a keypress just made or left, to write in next: null is the title.
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const setItems = (change: (items: ChecklistItem[]) => ChecklistItem[]) =>
    board.update(id, (x) => (x.kind === "checklist" ? { ...x, items: change(x.items) } : x));
  const addAfter = (index: number) => {
    const item = { id: mintId("item"), text: "", done: false };
    setItems((items) => [...items.slice(0, index + 1), item, ...items.slice(index + 1)]);
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
      setItems((items) => {
        const next = [...items];
        const [moved] = next.splice(drag.from, 1);
        next.splice(drag.to, 0, moved!);
        return next;
      });
    }
    setDrag(null);
  };

  return (
    <BoxShell id={id} object={o} selected={!!selected}>
      <div className="flex h-full w-full flex-col gap-1 overflow-hidden rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg3)] p-2 text-[var(--color-fg)] shadow-[var(--hm-shadow-2)]">
        {editing
          ? <TextLine value={o.text} of={o} autoFocus={focusLine === null} aria-label="checklist title" placeholder="Checklist"
              className="text-[13px] font-semibold"
              onCommit={(text) => board.update(id, (x) => (x.kind === "checklist" ? { ...x, text } : x))}
              onKey={(e, commit) => {
                if (e.key !== "Enter") return false;
                e.preventDefault();
                commit();
                addAfter(-1);
                return true;
              }} />
          : <div className="truncate text-[13px] font-semibold" data-board-text>{o.text || <span className="opacity-50">Checklist</span>}</div>}
        <ul ref={listRef} className="nowheel flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {o.items.map((item, index) => (
            <li key={item.id} data-checklist-item={item.id}
              className={`flex items-center gap-1.5 rounded px-0.5 ${drag?.to === index && drag.from !== index ? "bg-[var(--color-bg4)]" : ""}`}>
              <span aria-hidden className="nodrag nopan cursor-grab text-[var(--color-fg3)] active:cursor-grabbing"
                onPointerDown={gripDown(index)} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={() => setDrag(null)}>
                <GripVertical className="size-3" />
              </span>
              <button type="button" role="checkbox" aria-checked={item.done} aria-label={item.text || "item"}
                className="nodrag nopan grid size-3.5 shrink-0 place-items-center rounded-sm border border-[var(--color-line2)] bg-[var(--color-bg2)]"
                onClick={() => setItems((items) => items.map((it) => (it.id === item.id ? { ...it, done: !it.done } : it)))}>
                {item.done && <Check className="size-3" />}
              </button>
              {editing
                ? <TextLine value={item.text} of={item} autoFocus={focusLine === item.id} aria-label="item" className="flex-1 text-[13px]"
                    onCommit={(text) => setItems((items) => items.map((it) => (it.id === item.id ? { ...it, text } : it)))}
                    onKey={(e, commit) => {
                      if (e.key === "Enter") { e.preventDefault(); commit(); addAfter(index); return true; }
                      if (e.key === "Backspace" && e.currentTarget.value === "") {
                        e.preventDefault();
                        setItems((items) => items.filter((it) => it.id !== item.id));
                        setFocusLine(index > 0 ? o.items[index - 1]!.id : null);
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
            onClick={() => addAfter(o.items.length - 1)}>
            <Plus className="size-3" />Add item
          </button>
        )}
      </div>
    </BoxShell>
  );
});

/** Node types for the board's boxes; a box's node type is its kind. */
export const boardNodeTypes: NodeTypes = {
  note: NoteNode as unknown as NodeTypes[string],
  text: TextNode as unknown as NodeTypes[string],
  checklist: ChecklistNode as unknown as NodeTypes[string],
};
