/**
 * Arrows on the board (docs/design/multiplayer-2026-09-28.md, R15, §4.2 G): from one tile, frame
 * or board object to another, meeting each on the side it was drawn to and following either end
 * as it moves. A click selects one, a double-click writes its label in place.
 *
 * They are drawn in a layer of our own inside the canvas's viewport, not as react-flow edges:
 * react-flow draws an edge only between nodes with connection handles, and tiles and frames have
 * none. The layer sits over the frames' tint and under the tiles and boxes.
 *
 * Also here, because all of it needs react-flow's own view of the canvas: drawing one
 * (`ArrowDraft`, the layer that takes the two clicks) and where the pointer is (`BoardPointer`,
 * so a new box appears under it).
 */
import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { getBezierPath, Position, useInternalNode, useReactFlow, ViewportPortal, type InternalNode } from "@xyflow/react";
import type { ArrowObject, Side } from "@hivemind/workspace-doc/shapes";
import { facingSides, hitTest, sidePoint, type Point, type Rect } from "./board-model";
import { useBoardContext } from "./board-context";
import { TextLine } from "./TextDraft";

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

function rectOf(node: InternalNode): Rect {
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, w: node.measured?.width ?? 0, h: node.measured?.height ?? 0 };
}

/** An arrow's curve and the middle of it, or null while either end is not on the canvas. */
function useArrowPath(arrow: ArrowObject): { path: string; mid: Point } | null {
  const s = useInternalNode(arrow.from.id);
  const t = useInternalNode(arrow.to.id);
  if (!s || !t) return null;
  const from = sidePoint(rectOf(s), arrow.from.side);
  const to = sidePoint(rectOf(t), arrow.to.side);
  const [path, x, y] = getBezierPath({
    sourceX: from.x, sourceY: from.y, sourcePosition: POSITION[arrow.from.side],
    targetX: to.x, targetY: to.y, targetPosition: POSITION[arrow.to.side],
  });
  return { path, mid: { x, y } };
}

/** Every arrow on the board. */
export function BoardArrows() {
  const board = useBoardContext();
  const arrows = board.objects.filter((o): o is ArrowObject => o.kind === "arrow");
  if (arrows.length === 0) return null;
  return (
    <ViewportPortal>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} data-board-arrows>
        <defs>
          {(["fg3", "select"] as const).map((c) => (
            <marker key={c} id={`hm-arrowhead-${c}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: `var(--color-${c})` }} />
            </marker>
          ))}
        </defs>
        {arrows.map((a) => <ArrowPath key={a.id} arrow={a} selected={a.id === board.selectedId} />)}
      </svg>
      {arrows.map((a) => <ArrowLabel key={a.id} arrow={a} />)}
    </ViewportPortal>
  );
}

function ArrowPath({ arrow, selected }: { arrow: ArrowObject; selected: boolean }) {
  const board = useBoardContext();
  const shape = useArrowPath(arrow);
  if (!shape) return null;
  const color = selected ? "select" : "fg3";
  return (
    <g data-board-arrow={arrow.id}>
      <path d={shape.path} fill="none" strokeWidth={selected ? 2.5 : 2} markerEnd={`url(#hm-arrowhead-${color})`}
        style={{ stroke: `var(--color-${color})` }} />
      {/* The wide, invisible line a click lands on. */}
      <path d={shape.path} fill="none" strokeWidth={16} className="nopan" style={{ stroke: "transparent", pointerEvents: "stroke", cursor: "pointer" }}
        onClick={(e) => { e.stopPropagation(); board.select(arrow.id); }}
        onDoubleClick={(e) => { e.stopPropagation(); board.edit(arrow.id); }} />
    </g>
  );
}

function ArrowLabel({ arrow }: { arrow: ArrowObject }) {
  const board = useBoardContext();
  const shape = useArrowPath(arrow);
  const editing = board.editingId === arrow.id;
  if (!shape || (!editing && !arrow.label)) return null;
  return (
    <div className="nodrag nopan hm-island absolute left-0 top-0 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--color-fg)]"
      style={{ transform: `translate(-50%, -50%) translate(${shape.mid.x}px, ${shape.mid.y}px)`, pointerEvents: "all" }}
      data-arrow-label={arrow.id} onDoubleClick={() => board.edit(arrow.id)}>
      {editing
        ? <TextLine value={arrow.label} of={arrow} autoFocus aria-label="arrow label" placeholder="Label" className="w-32"
            onCommit={(edit) => board.update(arrow.id, (x) => (x.kind === "arrow" ? { ...x, label: edit(x.label) } : x))}
            onKey={(e, commit) => {
              if (e.key !== "Enter") return false;
              e.preventDefault();
              commit();
              board.edit(null);
              return true;
            }} />
        : arrow.label}
    </div>
  );
}

/**
 * Drawing an arrow: after "Arrow" in the Board menu, a click on a tile, frame or board object
 * picks where it starts and a second where it ends. This layer takes both clicks, so a tile's
 * body never sees them, and finds what is under each the way the canvas stacks it: front-most
 * node first. The canvas keys' Esc cancels.
 */
export function ArrowDraft() {
  const board = useBoardContext();
  const { getNodes, getInternalNode, screenToFlowPosition, flowToScreenPosition } = useReactFlow();
  const [pointer, setPointer] = useState<Point | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  if (board.arrowFrom === undefined) return null;
  const from = board.arrowFrom;
  const targets = () => getNodes()
    .map((n) => getInternalNode(n.id))
    .filter((n): n is InternalNode => !!n)
    .sort((a, b) => b.internals.z - a.internals.z)
    .map((n) => ({ id: n.id, rect: rectOf(n) }));
  const at = (e: { clientX: number; clientY: number }) => screenToFlowPosition({ x: e.clientX, y: e.clientY });
  // The preview line runs in this layer's own pixels, from the start's side to the pointer.
  const start = from && pointer ? sidePoint(from.rect, facingSides(from.rect, { ...pointer, w: 0, h: 0 })[0]) : null;
  const origin = layer.current?.getBoundingClientRect();
  const line = start && pointer && origin ? { a: flowToScreenPosition(start), b: flowToScreenPosition(pointer) } : null;
  return (
    <div ref={layer} className="absolute inset-0 z-10 cursor-crosshair" data-arrow-draft
      onPointerMove={(e) => setPointer(at(e))}
      onClick={(e) => { const hit = hitTest(at(e), targets()); if (hit) board.pickArrowEnd(hit); }}>
      <div className="hm-island pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 rounded-lg px-3 py-1.5 text-[12px] text-[var(--color-fg2)]">
        {from ? "Click where the arrow ends" : "Click the tile, frame or note the arrow starts at"} · Esc cancels
      </div>
      {line && origin && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <line x1={line.a.x - origin.left} y1={line.a.y - origin.top} x2={line.b.x - origin.left} y2={line.b.y - origin.top}
            stroke="var(--color-select)" strokeWidth={2} strokeDasharray="6 4" />
        </svg>
      )}
    </div>
  );
}

/** Keeps `target` able to say where on the canvas the pointer is, or the middle of the pane when it is not over it. */
export function BoardPointer({ target, pane }: { target: MutableRefObject<(() => Point) | null>; pane: RefObject<HTMLElement | null> }) {
  const { screenToFlowPosition } = useReactFlow();
  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    let last: Point | null = null;
    const move = (e: PointerEvent) => { last = { x: e.clientX, y: e.clientY }; };
    const leave = () => { last = null; };
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave);
    target.current = () => {
      const r = el.getBoundingClientRect();
      return screenToFlowPosition(last ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      target.current = null;
    };
  }, [target, pane, screenToFlowPosition]);
  return null;
}
