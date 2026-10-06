/**
 * A widget on the board, drawn from what its code last rendered: a small tree of text, numbers,
 * meters, buttons, rows and stacks, drawn by the app. Anyone who sees the board sees it, without
 * the widget's package. Its buttons work where its code runs.
 */
import { memo, type ReactNode } from "react";
import { NodeResizer } from "@xyflow/react";
import { Copy, Trash } from "lucide-react";
import type { WidgetObject } from "@hivemind/workspace-doc/shapes";
import { Button } from "../components/ui/button";
import { useBoardContext } from "./board-context";
import { BOX_SIZE } from "./board-model";
import { pressWidget } from "./widget-runtime";

type Tree = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function draw(node: unknown, id: string, key: number | string = 0, depth = 0): ReactNode {
  if (depth > 8 || typeof node !== "object" || node === null) return null;
  const n = node as Tree;
  const kids = Array.isArray(n.children) ? n.children.slice(0, 50).map((c, i) => draw(c, id, i, depth + 1)) : null;
  switch (n.type) {
    case "stack": return <div key={key} className="flex min-w-0 flex-col gap-1.5">{kids}</div>;
    case "row": return <div key={key} className="flex min-w-0 items-center gap-2">{kids}</div>;
    case "text": return <span key={key} className={`truncate ${n.size === "large" ? "text-[18px] font-semibold" : n.muted ? "text-[11px] text-[var(--color-fg3)]" : "text-[13px]"}`}>{str(n.text)}</span>;
    case "number": return <div key={key} className="flex flex-col"><span className="text-[26px] font-semibold tabular-nums leading-none">{str(n.value)}</span>{n.label != null && <span className="text-[11px] text-[var(--color-fg3)]">{str(n.label)}</span>}</div>;
    case "meter": {
      const max = Math.max(num(n.max, 1), 1e-9);
      const pct = Math.min(100, Math.max(0, (num(n.value) / max) * 100));
      return <div key={key} className="flex flex-col gap-1">
        {n.label != null && <span className="text-[11px] text-[var(--color-fg3)]">{str(n.label)}</span>}
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg3)]" role="meter" aria-valuenow={num(n.value)} aria-valuemax={max}>
          <div className="h-full rounded-full bg-[var(--color-select)]" style={{ width: `${pct}%` }} />
        </div>
      </div>;
    }
    case "button": return <Button key={key} size="sm" variant="outline" className="nodrag nopan self-start"
      onClick={() => { if (!pressWidget(id, n.action)) console.info("this widget's code runs on the workspace's host"); }}>{str(n.label)}</Button>;
    default: return null;
  }
}

export const WidgetNode = memo(function WidgetNode({ id, data, selected }: { id: string; data: { object: WidgetObject }; selected?: boolean }) {
  const board = useBoardContext();
  const o = data.object;
  const size = BOX_SIZE.widget;
  return (
    <div data-board-object="widget" data-widget={o.widget} className={`nopan hm-island relative flex h-full w-full flex-col overflow-hidden rounded-xl p-3${selected ? " hm-board-selected" : ""}`}>
      <NodeResizer nodeId={id} isVisible={!!selected} minWidth={size.minW} minHeight={size.minH} color="var(--color-select)"
        onResizeEnd={(_e, p) => board.resize(id, p.width, p.height, p.x, p.y)} />
      {selected && <div className="nodrag nopan hm-island absolute -top-10 left-0 flex items-center gap-1 rounded-lg p-1" data-board-bar>
        <Button variant="ghost" size="icon-sm" aria-label="duplicate" onClick={() => board.duplicate(id)}><Copy /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="delete" onClick={() => board.remove(id)}><Trash /></Button>
      </div>}
      {o.render === undefined ? <span className="text-[12px] text-[var(--color-fg3)]">{o.widget}: waiting for it to draw</span> : draw(o.render, id)}
    </div>
  );
});
