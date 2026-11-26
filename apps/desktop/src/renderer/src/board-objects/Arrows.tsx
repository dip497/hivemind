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
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useInternalNode, useReactFlow, ViewportPortal, type InternalNode, type Node } from "@xyflow/react";
import { ARROW_ROUTES, SHAPE_COLORS, SHAPE_DASHES, type ArrowObject, type ArrowRoute, type Side } from "@hivemind/workspace-doc/shapes";
import { routeArrow } from "@hivemind/workspace-doc/arrow-route";
import { strokePixels } from "@hivemind/workspace-doc/drawing";
import { dashPattern } from "@hivemind/workspace-doc/stroke-smooth";
import { facingSides, hitTest, sidePoint, type Point, type Rect } from "./board-model";
import { useBoardContext } from "./board-context";
import { TextLine } from "./TextDraft";
import { inkVar } from "./shape-ink";
import { OUTSIDE_FOCUS } from "../canvas-node-build";

const SIDE_MIDDLE: Record<Side, [number, number]> = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5] };
const MOST_BOXES_AVOIDED = 40;

type ArrowLine = ReturnType<typeof routeArrow>;
type EndName = "from" | "to";
interface EndDrag { id: string; end: EndName; at: [number, number] }

/** Where a node is on the canvas; one never shown (a painted shape) by the size it was given. */
export function rectOf(node: InternalNode): Rect {
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, w: node.measured?.width ?? node.initialWidth ?? 0, h: node.measured?.height ?? node.initialHeight ?? 0 };
}

const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Every box on the canvas, read once for each change of the canvas's nodes and shared by all arrows. */
const boxesOf = new WeakMap<readonly Node[], Array<{ id: string; rect: Rect }>>();

function boxesOn(nodes: readonly Node[], internal: (id: string) => InternalNode | undefined): Array<{ id: string; rect: Rect }> {
  let boxes = boxesOf.get(nodes);
  if (!boxes) {
    boxes = [];
    for (const n of nodes) {
      const node = internal(n.id);
      if (!node) continue;
      const rect = rectOf(node);
      if (rect.w > 0 && rect.h > 0) boxes.push({ id: n.id, rect });
    }
    boxesOf.set(nodes, boxes);
  }
  return boxes;
}

/** The boxes an elbow arrow walks round: the nearest ones that neither end sits in or on. */
function boxesInTheWay(boxes: ReadonlyArray<{ id: string; rect: Rect }>, arrow: ArrowObject, from: Rect, to: Rect): Rect[] {
  const cx = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
  const cy = (from.y + from.h / 2 + to.y + to.h / 2) / 2;
  const far = (r: Rect): number => Math.abs(r.x + r.w / 2 - cx) + Math.abs(r.y + r.h / 2 - cy);
  return boxes
    .filter((b) => b.id !== arrow.from.id && b.id !== arrow.to.id && !overlap(b.rect, from) && !overlap(b.rect, to))
    .map((b) => b.rect)
    .sort((a, b) => far(a) - far(b))
    .slice(0, MOST_BOXES_AVOIDED);
}

/** The line last worked out for each arrow, kept until an end moves or the arrow's route changes. */
const linesKept = new Map<string, { key: string; line: ArrowLine }>();

/** An arrow's line and the middle of it, or null while either end is not on the canvas. */
function useArrowLine(arrow: ArrowObject): { line: ArrowLine; from: Rect; to: Rect } | null {
  const s = useInternalNode(arrow.from.id);
  const t = useInternalNode(arrow.to.id);
  const { getNodes, getInternalNode } = useReactFlow();
  useEffect(() => () => { linesKept.delete(arrow.id); }, [arrow.id]);
  if (!s || !t) return null;
  const from = rectOf(s);
  const to = rectOf(t);
  const fromAt = arrow.fromAt ?? SIDE_MIDDLE[arrow.from.side];
  const toAt = arrow.toAt ?? SIDE_MIDDLE[arrow.to.side];
  const key = `${arrow.route ?? ""}|${from.x},${from.y},${from.w},${from.h}|${to.x},${to.y},${to.w},${to.h}|${fromAt[0]},${fromAt[1]}|${toAt[0]},${toAt[1]}`;
  const kept = linesKept.get(arrow.id);
  if (kept?.key === key) return { line: kept.line, from, to };
  const avoid = arrow.route === "elbow" ? boxesInTheWay(boxesOn(getNodes(), getInternalNode), arrow, from, to) : [];
  const line = routeArrow(from, to, arrow.route, avoid, { fromAt, toAt });
  linesKept.set(arrow.id, { key, line });
  return { line, from, to };
}

/** Every arrow on the board; one whose start is in `dimmed` (outside the frame the window is inside) dims. */
export function BoardArrows({ dimmed }: { dimmed: ReadonlySet<string> | null }) {
  const board = useBoardContext();
  const [drag, setDrag] = useState<EndDrag | null>(null);
  const stored = board.objects.filter((o): o is ArrowObject => o.kind === "arrow");
  if (stored.length === 0) return null;
  const arrows = drag ? stored.map((a) => (a.id !== drag.id ? a : drag.end === "from" ? { ...a, fromAt: drag.at } : { ...a, toAt: drag.at })) : stored;
  const selected = board.selectedIds.length <= 1 ? arrows.find((a) => a.id === board.selectedId) : undefined;
  return (
    <ViewportPortal>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} data-board-arrows>
        <defs>
          {(["fg3", "select", ...SHAPE_COLORS] as const).map((c) => (
            <marker key={c} id={`hm-arrowhead-${c}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={14} markerHeight={14} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: c === "fg3" || c === "select" ? `var(--color-${c})` : inkVar(c) }} />
            </marker>
          ))}
        </defs>
        {arrows.map((a) => <ArrowPath key={a.id} arrow={a} selected={a.id === board.selectedId} dim={!!dimmed?.has(a.from.id)} />)}
      </svg>
      {arrows.map((a) => <ArrowLabel key={a.id} arrow={a} />)}
      {selected && board.editingId !== selected.id && <ArrowBar arrow={selected} />}
      {selected && <ArrowEndDot arrow={selected} end="from" drag={drag} setDrag={setDrag} />}
      {selected && <ArrowEndDot arrow={selected} end="to" drag={drag} setDrag={setDrag} />}
    </ViewportPortal>
  );
}

function ArrowPath({ arrow, selected, dim }: { arrow: ArrowObject; selected: boolean; dim: boolean }) {
  const board = useBoardContext();
  const shape = useArrowLine(arrow);
  if (!shape) return null;
  const inked = !selected && (SHAPE_COLORS as readonly string[]).includes(arrow.color ?? "");
  const color = selected ? "select" : inked ? arrow.color! : "fg3";
  const px = strokePixels(arrow.weight) + (selected ? 0.5 : 0);
  const dashes = dashPattern(arrow.dash, px);
  const head = `url(#hm-arrowhead-${color})`;
  return (
    <g data-board-arrow={arrow.id} className={dim ? OUTSIDE_FOCUS : undefined}>
      <path d={shape.line.path} fill="none" strokeWidth={px} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={dashes.length > 0 ? dashes.join(" ") : undefined}
        markerEnd={head} markerStart={arrow.tail ? head : undefined}
        style={{ stroke: inked ? inkVar(color) : `var(--color-${color})` }} />
      {/* The wide, invisible line a click lands on. */}
      <path d={shape.line.path} fill="none" strokeWidth={16} className="nopan" data-arrow-hit style={{ stroke: "transparent", pointerEvents: "stroke", cursor: "pointer" }}
        onClick={(e) => { e.stopPropagation(); board.select(arrow.id); }}
        onDoubleClick={(e) => { e.stopPropagation(); board.edit(arrow.id); }} />
    </g>
  );
}

function ArrowLabel({ arrow }: { arrow: ArrowObject }) {
  const board = useBoardContext();
  const shape = useArrowLine(arrow);
  const editing = board.editingId === arrow.id;
  if (!shape || (!editing && !arrow.label)) return null;
  const { mid } = shape.line;
  return (
    <div className="nodrag nopan hm-island absolute left-0 top-0 rounded-md px-1.5 py-0.5 text-label text-[var(--color-fg)]"
      style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`, pointerEvents: "all" }}
      data-arrow-label={arrow.id} onClick={() => board.select(arrow.id)} onDoubleClick={() => board.edit(arrow.id)}>
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

const ROUTE_WORD: Record<ArrowRoute, string> = { straight: "Straight", elbow: "Elbow", curve: "Curve" };

/** The small bar over a selected arrow's middle: how it runs, its line, its heads, and taking it away. */
function ArrowBar({ arrow }: { arrow: ArrowObject }) {
  const board = useBoardContext();
  const shape = useArrowLine(arrow);
  if (!shape) return null;
  const { mid } = shape.line;
  const change = (to: Partial<ArrowObject>) => board.update(arrow.id, (x) => (x.kind === "arrow" ? { ...x, ...to } : x));
  const route = arrow.route ?? "curve";
  const dash = arrow.dash ?? "solid";
  const button = "rounded px-1.5 py-0.5 text-label text-[var(--color-fg2)] hover:text-[var(--color-fg)] aria-pressed:bg-[var(--color-select)] aria-pressed:text-[var(--color-bg)]";
  return (
    <div className="nodrag nopan hm-island absolute left-0 top-0 flex items-center gap-0.5 whitespace-nowrap rounded-md p-0.5"
      style={{ transform: `translate(-50%, -100%) translate(${mid.x}px, ${mid.y - 18}px)`, pointerEvents: "all" }}
      role="toolbar" aria-label="Arrow" data-arrow-bar={arrow.id} onDoubleClick={(e) => e.stopPropagation()}>
      {ARROW_ROUTES.map((r) => (
        <button key={r} type="button" className={button} aria-pressed={route === r} onClick={() => change({ route: r })}>{ROUTE_WORD[r]}</button>
      ))}
      <button type="button" className={button} aria-label={`Line: ${dash}`}
        onClick={() => change({ dash: SHAPE_DASHES[(SHAPE_DASHES.indexOf(dash) + 1) % SHAPE_DASHES.length] })}>
        {dash === "solid" ? "Solid" : dash === "dashed" ? "Dashed" : "Dotted"}
      </button>
      <button type="button" className={button} aria-pressed={!!arrow.tail} onClick={() => change({ tail: !arrow.tail })}>Both ends</button>
      <button type="button" className={button} onClick={() => board.remove(arrow.id)}>Delete</button>
    </div>
  );
}

/** Where on `box` the point nearest `p` is, as fractions of the box, held to its edge. */
function onEdge(box: Rect, p: Point): [number, number] {
  const fx = Math.min(1, Math.max(0, (p.x - box.x) / (box.w || 1)));
  const fy = Math.min(1, Math.max(0, (p.y - box.y) / (box.h || 1)));
  const nearest = Math.min(fx, 1 - fx, fy, 1 - fy);
  const held = (n: number): number => Math.round(n * 100) / 100;
  if (nearest === fx) return [0, held(fy)];
  if (nearest === 1 - fx) return [1, held(fy)];
  if (nearest === fy) return [held(fx), 0];
  return [held(fx), 1];
}

/** The dot on a selected arrow's end: dragged along its box, the arrow meets the box there. */
function ArrowEndDot({ arrow, end, drag, setDrag }: { arrow: ArrowObject; end: EndName; drag: EndDrag | null; setDrag: (drag: EndDrag | null) => void }) {
  const board = useBoardContext();
  const { screenToFlowPosition } = useReactFlow();
  const shape = useArrowLine(arrow);
  if (!shape) return null;
  const points = shape.line.points;
  const at = end === "from" ? points[0] : points[points.length - 1];
  if (!at) return null;
  const box = end === "from" ? shape.from : shape.to;
  const mine = drag?.id === arrow.id && drag.end === end ? drag : null;
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const next = onEdge(box, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    if (mine && mine.at[0] === next[0] && mine.at[1] === next[1]) return;
    setDrag({ id: arrow.id, end, at: next });
  };
  const drop = () => {
    if (!mine) return;
    const at = mine.at;
    board.update(arrow.id, (x) => (x.kind !== "arrow" ? x : end === "from" ? { ...x, fromAt: at } : { ...x, toAt: at }));
    setDrag(null);
  };
  return (
    <div className="nodrag nopan absolute left-0 top-0 h-2.5 w-2.5 cursor-grab rounded-full border border-[var(--color-bg)] bg-[var(--color-select)]"
      style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`, pointerEvents: "all", touchAction: "none" }}
      data-arrow-end={end}
      onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={move} onPointerUp={drop} onPointerCancel={() => setDrag(null)} />
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
      <div className="hm-island pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 rounded-lg px-3 py-1.5 text-label text-[var(--color-fg2)]">
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
