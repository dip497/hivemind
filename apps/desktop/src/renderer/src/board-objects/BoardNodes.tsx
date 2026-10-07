/**
 * The board's boxes on the canvas (docs/design/multiplayer-2026-09-28.md, R15, §4.2 G): widgets
 * placed on the board (sticky notes, text labels and checklists among them), drawn by plain React
 * — no TileHost surface, no session. A click selects one, a double-click writes in it; a selected
 * one shows its resize handles and a small bar (options, duplicate, delete). Node data is the
 * object alone; every edit goes through the board (BoardContext).
 */
import { memo, useState, type ReactNode } from "react";
import { NodeResizer, type NodeTypes } from "@xyflow/react";
import { Copy, Settings2, Trash } from "lucide-react";
import { Button } from "../components/ui/button";
import { BOX_SIZE, type BoardWidget, type BoxObject } from "./board-model";
import { WidgetContent, widgetTint, widgetTree } from "./WidgetBody";
import { optionsOf, useShownWidgetPackages } from "./widget-runtime";
import { SettingsForm } from "../plugins/SettingsForm";
import { useBoardContext } from "./board-context";

interface BoxNodeProps<T extends BoxObject> {
  id: string;
  data: { object: T };
  selected?: boolean;
}

const HANDLE = { width: 10, height: 10, borderRadius: 3, border: "2px solid var(--color-bg)" } as const;

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
  const pkg = useShownWidgetPackages().find((p) => object.kind === "widget" && p.id === object.widget);
  const [setting, setSetting] = useState(false);
  return (
    <div className="nodrag nopan hm-island absolute -top-10 left-0 flex items-center gap-1 rounded-lg p-1" data-board-bar>
      {pkg?.options.filter((o) => o.type === "choice" && o.id === "color").map((o) => o.type === "choice" && o.values.map((c) => (
        <button key={c} type="button" aria-label={`${c} ${pkg.name}`} aria-pressed={optionsOf(pkg, object).color === c} data-note-color={c}
          className={`size-5 rounded-full border-2 ${optionsOf(pkg, object).color === c ? "border-[var(--color-fg)]" : "border-transparent"}`}
          style={{ background: `var(--color-note-${c})` }}
          onClick={() => board.update(id, (x) => (x.kind === "widget" ? { ...x, options: { ...x.options, color: c } } : x))} />
      )))}
      {!!pkg?.options.some((o) => o.id !== "color") && (
        <Button variant="ghost" size="icon-sm" aria-label={`${pkg.name} options`} aria-pressed={setting} data-widget-options onClick={() => setSetting((v) => !v)}><Settings2 /></Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="duplicate" title="Duplicate  (⌘D)" onClick={() => board.duplicate(id)}><Copy /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="delete" title="Delete  (⌫)" onClick={() => board.remove(id)}><Trash /></Button>
      {setting && pkg && (
        <div className="hm-island absolute left-0 top-full mt-1 w-[240px] rounded-xl p-3">
          <SettingsForm compact fields={pkg.options} values={optionsOf(pkg, object)}
            onChange={(option, value) => board.update(id, (o) => (o.kind === "widget" ? { ...o, options: { ...o.options, [option]: value } } : o))} />
        </div>
      )}
    </div>
  );
}

/** A widget placed on the board: in a box like a note's, drawn as everywhere else. */
const WidgetBoxNode = memo(function WidgetBoxNode({ id, data, selected }: BoxNodeProps<BoardWidget>) {
  const o = data.object;
  const pkg = useShownWidgetPackages().find((p) => p.id === o.widget);
  // A tinted widget (a sticky note) is its colour, as a note is; any other is a card.
  const tint = widgetTint(widgetTree(o, pkg, undefined));
  const bare = pkg?.chrome === "none";
  return (
    <BoxShell id={id} object={o} selected={!!selected}>
      <div data-widget={o.widget}
        className={`flex h-full w-full flex-col overflow-hidden ${bare ? "px-1 text-[var(--color-fg)]" : tint ? "rounded-md p-3 shadow-[var(--hm-shadow-2)]" : "hm-island rounded-xl p-3"}`}
        style={tint && !bare ? { background: tint, color: "var(--color-note-ink)" } : undefined}>
        <WidgetContent object={o} pkg={pkg} selected={!!selected} />
      </div>
    </BoxShell>
  );
});

/** Node types for the board's boxes; a box's node type is its kind. */
export const boardNodeTypes: NodeTypes = {
  widget: WidgetBoxNode as unknown as NodeTypes[string],
};
