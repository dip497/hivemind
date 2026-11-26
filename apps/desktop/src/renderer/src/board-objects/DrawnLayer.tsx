/**
 * What is drawn on the board, every shape with no writing, painted on one canvas over the tiles:
 * a board may hold thousands, and a node each would make every pan touch them all. Only what is on
 * screen is painted, and a shape's outline is made once. Their nodes stay on the canvas, hidden,
 * so arrows, notes and frames find them as before; a selected one is shown as its node, with its
 * handles. Clicks on them are found here, by what is drawn, so a terminal under a stroke still
 * takes the rest.
 */
import { useContext, useEffect, useRef } from "react";
import { useStoreApi, type Node, type ReactFlowState } from "@xyflow/react";
import { shapeHit, shapeOutline, strokePixels, type Rect } from "@hivemind/workspace-doc/drawing";
import { isStroke, type ShapeObject } from "@hivemind/workspace-doc/shapes";
import { dashPattern, smoothStroke } from "@hivemind/workspace-doc/stroke-smooth";
import { roughPath } from "@hivemind/workspace-doc/rough";
import { snapMove, type SnapLine } from "@hivemind/workspace-doc/snap";
import { groupOf, paintedHere } from "./board-model";
import { BoardRefContext } from "./board-context";
import { inkVar } from "./shape-ink";
import { OUTSIDE_FOCUS } from "../canvas-node-build";

/** How strongly what is outside the frame the window is inside is painted (the nodes' own dim is CSS). */
const DIMMED = 0.3;

/** What the eraser has gone over and not yet taken: painted faint. */
export const fadingDrawn = new Set<string>();
let askPaint: (() => void) | null = null;
export function repaintDrawn(): void { askPaint?.(); }

interface Drawn { id: string; o: ShapeObject; dim: boolean; selected?: boolean }
const outlines = new WeakMap<ShapeObject, Path2D>();
const outlineOf = (o: ShapeObject): Path2D => {
  let path = outlines.get(o);
  if (!path) outlines.set(o, (path = new Path2D(shapeOutline(o))));
  return path;
};
const MARKER_WIDTH = 14;
const widthOf = (o: ShapeObject): number => (o.marker ? MARKER_WIDTH : o.weight ? strokePixels(o.weight) : 2);
const plainLine = (o: ShapeObject): boolean => !o.dash || o.dash === "solid";
/** What is stroked or, for a pen stroke, filled: the pen's own outline, or the hand-drawn one. */
const inked = new WeakMap<ShapeObject, Path2D>();
const penFilled = (o: ShapeObject): boolean => o.form === "pen" && !o.marker && plainLine(o);
function inkedOf(o: ShapeObject): Path2D {
  let path = inked.get(o);
  if (path) return path;
  if (penFilled(o)) {
    path = new Path2D();
    const outline = smoothStroke(o.points ?? [], widthOf(o) * 1.25);
    outline.forEach((p, i) => (i ? path!.lineTo(p[0], p[1]) : path!.moveTo(p[0], p[1])));
    path.closePath();
  } else path = o.rough && !o.marker ? new Path2D(roughPath(o)) : outlineOf(o);
  inked.set(o, path);
  return path;
}

/** The hidden shape nodes, back to front: found again only when the nodes change. */
let drawnFrom: Node[] | null = null;
let drawnList: Drawn[] = [];
function drawnIn(nodes: Node[]): Drawn[] {
  if (nodes === drawnFrom) return drawnList;
  const out: Drawn[] = [];
  for (const n of nodes) if (n.hidden && n.type === "shape") out.push({ id: n.id, o: (n.data as { object: ShapeObject }).object, dim: n.className === OUTSIDE_FOCUS, selected: !!n.selected });
  drawnFrom = nodes;
  drawnList = out.sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
  return drawnList;
}

/** Every shape this layer paints that a drag can take in: the selected ones too, which are shown as
 *  their nodes meanwhile, and not what dims outside the frame the window is inside. */
function paintableIn(nodes: Node[]): Drawn[] {
  const out: Drawn[] = [];
  for (const n of nodes) {
    if (n.type !== "shape" || n.className === OUTSIDE_FOCUS) continue;
    const o = (n.data as { object: ShapeObject }).object;
    if (paintedHere(o)) out.push({ id: n.id, o, dim: false });
  }
  return out;
}
const placed = (s: ReactFlowState, d: Drawn): ShapeObject => {
  const at = s.nodeLookup.get(d.id)?.internals.positionAbsolute;
  return at && (at.x !== d.o.x || at.y !== d.o.y) ? { ...d.o, x: at.x, y: at.y } : d.o;
};

export function DrawnLayer({ pane, onTakeIn }: {
  pane: React.RefObject<HTMLDivElement | null>;
  /** A drag across the canvas is over these painted shapes. */
  onTakeIn: (ids: string[]) => void;
}) {
  const store = useStoreApi();
  const boardRef = useContext(BoardRefContext);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const takeIn = useRef(onTakeIn);
  takeIn.current = onTakeIn;

  // Painting: at most once a frame, and only when what is shown changed.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return undefined;
    let frame = 0;
    let last: unknown[] = [];
    let theme = 0;
    let taken: string | null = null;
    const listOf = (s: ReactFlowState) => drawnIn(s.nodes);
    const paint = () => {
      frame = 0;
      const s = store.getState();
      const [tx, ty, k] = s.transform;
      const now = [s.nodes, tx, ty, k, s.width, s.height, theme, fadingDrawn.size, dragging, hoveredId];
      if (now.every((v, i) => v === last[i])) return;
      last = now;
      const dpr = window.devicePixelRatio || 1;
      const [w, h] = [Math.round(s.width * dpr), Math.round(s.height * dpr)];
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${s.width}px`;
        canvas.style.height = `${s.height}px`;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(k * dpr, 0, 0, k * dpr, tx * dpr, ty * dpr);
      const [x0, y0, x1, y1] = [-tx / k, -ty / k, (s.width - tx) / k, (s.height - ty) / k];
      const look = getComputedStyle(canvas);
      const plain = look.getPropertyValue("--color-fg").trim();
      const inks = new Map<string, string>();
      const inkOf = (color: string | undefined) => {
        const name = inkVar(color).slice(4, -1);
        let v = inks.get(name);
        if (v === undefined) inks.set(name, (v = look.getPropertyValue(name).trim() || plain));
        return v;
      };
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const accent = look.getPropertyValue("--color-accent").trim() || plain;
      const paintAt = (d: Drawn, o: ShapeObject, x: number, y: number) => {
        const pad = 8 + (o.marker ? MARKER_WIDTH : 0);
        if (x + o.w + pad < x0 || y + o.h + pad < y0 || x - pad > x1 || y - pad > y1) return;
        if (o.w * k < 0.5 && o.h * k < 0.5) return;
        const ink = inkOf(o.color);
        const faded = (fadingDrawn.has(d.id) ? 0.25 : 1) * (d.dim ? DIMMED : 1);
        const width = widthOf(o);
        ctx.save();
        ctx.translate(x, y);
        ctx.lineWidth = width;
        if (d.selected || (d.id === hoveredId && !dragging)) {
          ctx.strokeStyle = accent;
          ctx.globalAlpha = d.selected ? 0.45 : 0.22;
          ctx.lineWidth = width + 8;
          ctx.stroke(outlineOf(d.o));
          ctx.lineWidth = width;
        }
        ctx.globalAlpha = faded;
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
        if (!isStroke(o.form) && o.filled) {
          ctx.globalAlpha = faded * 0.14;
          ctx.fill(outlineOf(d.o));
          ctx.globalAlpha = faded;
        }
        if (penFilled(o)) ctx.fill(inkedOf(d.o));
        else {
          if (o.marker) ctx.globalAlpha = faded * 0.35;
          else if (!plainLine(o)) ctx.setLineDash(dashPattern(o.dash, width));
          ctx.stroke(inkedOf(d.o));
          ctx.setLineDash([]);
          ctx.globalAlpha = faded;
        }
        if (o.head && o.points && o.points.length > 1) {
          const [a, b] = [o.points[o.points.length - 2]!, o.points[o.points.length - 1]!];
          const turn = Math.atan2(b[1] - a[1], b[0] - a[0]);
          ctx.translate(b[0], b[1]);
          ctx.rotate(turn);
          ctx.beginPath();
          ctx.moveTo(1.4, 0);
          ctx.lineTo(-12.6, -7);
          ctx.lineTo(-12.6, 7);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      };
      for (const d of listOf(s)) {
        const moved = dragging?.ids.has(d.id) ? dragging : null;
        const o = placed(s, d);
        if (!moved || moved.copy) paintAt(d, o, o.x, o.y);
        if (moved) paintAt(d, o, o.x + moved.dx, o.y + moved.dy);
      }
      if (dragging && dragging.lines.length > 0) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1 / k;
        ctx.beginPath();
        for (const line of dragging.lines) {
          if (line.axis === "x") { ctx.moveTo(line.at, line.from); ctx.lineTo(line.at, line.to); }
          else { ctx.moveTo(line.from, line.at); ctx.lineTo(line.to, line.at); }
        }
        ctx.stroke();
      }
    };
    const ask = () => { if (!frame) frame = requestAnimationFrame(paint); };
    askPaint = ask;
    // A drag across the canvas takes in the painted shapes wholly inside it.
    const watchTakeIn = (s: ReactFlowState) => {
      const r = s.userSelectionActive ? s.userSelectionRect : null;
      if (!r) { taken = null; return; }
      const [tx, ty, k] = s.transform;
      const [x0, y0] = [(r.x - tx) / k, (r.y - ty) / k];
      const [x1, y1] = [x0 + r.width / k, y0 + r.height / k];
      const ids = paintableIn(s.nodes).filter((d) => {
        const o = placed(s, d);
        return o.x >= x0 && o.y >= y0 && o.x + o.w <= x1 && o.y + o.h <= y1;
      }).map((d) => d.id);
      const key = ids.join(" ");
      if (key !== taken) { taken = key; takeIn.current(ids); }
    };
    const stop = store.subscribe((s) => { ask(); watchTakeIn(s); });
    const look = new MutationObserver(() => { theme++; ask(); });
    look.observe(document.documentElement, { attributes: true });
    ask();
    return () => {
      stop();
      look.disconnect();
      cancelAnimationFrame(frame);
      if (askPaint === ask) askPaint = null;
    };
  }, [store]);

  // Clicks, drags and double-clicks on what is painted, while the Select tool is on.
  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    let space = false;
    let press: { id: string; ids: Set<string>; chosen: boolean; from: { x: number; y: number }; screen: { x: number; y: number }; moved: boolean; held: boolean; box: Rect | null; near: Rect[] } | null = null;
    const hover = (id: string | null) => {
      if (id === hoveredId) return;
      hoveredId = id;
      el.toggleAttribute("data-over-drawn", id !== null);
      askPaint?.();
    };
    /** Where the pressed shapes sit as one box, and the other painted shapes in view to line up with. */
    const around = (ids: Set<string>): { box: Rect | null; near: Rect[] } => {
      const s = store.getState();
      const [tx, ty, k] = s.transform;
      const [x0, y0, x1, y1] = [-tx / k, -ty / k, (s.width - tx) / k, (s.height - ty) / k];
      const near: Rect[] = [];
      let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const d of drawnIn(s.nodes)) {
        const o = placed(s, d);
        if (ids.has(d.id)) {
          left = Math.min(left, o.x); top = Math.min(top, o.y);
          right = Math.max(right, o.x + o.w); bottom = Math.max(bottom, o.y + o.h);
        } else if (!d.dim && o.x + o.w >= x0 && o.y + o.h >= y0 && o.x <= x1 && o.y <= y1) near.push({ x: o.x, y: o.y, w: o.w, h: o.h });
      }
      return { box: left <= right ? { x: left, y: top, w: right - left, h: bottom - top } : null, near };
    };
    let swallowClick = false;
    const keyDown = (e: KeyboardEvent) => { if (e.code === "Space") space = true; };
    const keyUp = (e: KeyboardEvent) => { if (e.code === "Space") space = false; };
    const flowAt = (e: MouseEvent) => {
      const [tx, ty, k] = store.getState().transform;
      const box = el.getBoundingClientRect();
      return { x: (e.clientX - box.left - tx) / k, y: (e.clientY - box.top - ty) / k };
    };
    const ours = (e: MouseEvent): boolean => {
      const target = e.target as Element | null;
      const board = boardRef?.current;
      return !!board && board.tool === "select" && !space && !!target && el.contains(target)
        && !target.closest?.(".react-flow__panel, [data-note-card], [data-board-bar], .react-flow__resize-control, textarea, input, [contenteditable=true], .react-flow__node-shape.selected");
    };
    /** The front-most painted shape under the pointer. */
    const hitAt = (e: MouseEvent): Drawn | undefined => {
      const s = store.getState();
      const p = flowAt(e);
      const within = 7 / s.transform[2];
      const list = drawnIn(s.nodes);
      for (let i = list.length - 1; i >= 0; i--) if (shapeHit(placed(s, list[i]!), p, within)) return list[i];
      return undefined;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !ours(e)) return;
      const hit = hitAt(e);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const board = boardRef!.current;
      // A shape of a selection painted, not shown as nodes, moves the whole selection.
      const chosen = board.selectedIds.length > 1 && board.selectedIds.includes(hit.id);
      const ids = new Set(chosen ? board.selectedIds : groupOf(board.objectsRef.current, hit.id));
      const held = hit.o.locked === true || board.objectsRef.current.some((o) => o.kind === "shape" && o.locked === true && ids.has(o.id));
      press = { id: hit.id, ids, chosen, from: flowAt(e), screen: { x: e.clientX, y: e.clientY }, moved: false, held, ...(held ? { box: null, near: [] } : around(ids)) };
      hover(null);
      swallowClick = true;
    };
    const move = (e: PointerEvent) => {
      if (!press) {
        if (e.buttons === 0) hover(ours(e) ? hitAt(e)?.id ?? null : null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!press.moved && Math.hypot(e.clientX - press.screen.x, e.clientY - press.screen.y) < 4) return;
      if (press.held) return;
      press.moved = true;
      const p = flowAt(e);
      let [dx, dy] = [p.x - press.from.x, p.y - press.from.y];
      let lines: SnapLine[] = NO_LINES;
      if (press.box && !e.ctrlKey && press.near.length > 0) {
        const snap = snapMove({ x: press.box.x + dx, y: press.box.y + dy, w: press.box.w, h: press.box.h }, press.near, 6 / store.getState().transform[2]);
        dx += snap.dx;
        dy += snap.dy;
        lines = snap.lines;
      }
      dragging = { ids: press.ids, dx, dy, lines, copy: e.altKey };
      askPaint?.();
    };
    const up = (e: PointerEvent) => {
      if (!press) return;
      e.preventDefault();
      e.stopPropagation();
      const board = boardRef!.current;
      const done = press;
      const moved = dragging;
      press = null;
      dragging = null;
      if (moved?.copy) board.duplicateBy([...moved.ids], moved.dx, moved.dy);
      else {
        if (moved) board.nudge([...moved.ids], moved.dx, moved.dy);
        if (!moved || !done.chosen) board.select(done.id);
      }
      askPaint?.();
    };
    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const doubleClick = (e: MouseEvent) => {
      if (!ours(e)) return;
      const hit = hitAt(e);
      if (!hit || isStroke(hit.o.form)) return;
      e.preventDefault();
      e.stopPropagation();
      boardRef!.current.edit(hit.id);
    };
    window.addEventListener("pointerdown", down, { capture: true });
    window.addEventListener("pointermove", move, { capture: true });
    window.addEventListener("pointerup", up, { capture: true });
    window.addEventListener("pointercancel", up, { capture: true });
    window.addEventListener("click", click, { capture: true });
    window.addEventListener("dblclick", doubleClick, { capture: true });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      el.removeAttribute("data-over-drawn");
      hoveredId = null;
      window.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener("pointermove", move, { capture: true });
      window.removeEventListener("pointerup", up, { capture: true });
      window.removeEventListener("pointercancel", up, { capture: true });
      window.removeEventListener("click", click, { capture: true });
      window.removeEventListener("dblclick", doubleClick, { capture: true });
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [pane, store, boardRef]);

  return <canvas ref={canvasRef} data-drawn-layer className="pointer-events-none absolute left-0 top-0 z-[4]" />;
}

/** The painted shapes being moved, and by how much, while a drag of them runs. */
let dragging: { ids: Set<string>; dx: number; dy: number; lines: SnapLine[]; copy: boolean } | null = null;
const NO_LINES: SnapLine[] = [];
/** The painted shape under the pointer, outlined softly. */
let hoveredId: string | null = null;
