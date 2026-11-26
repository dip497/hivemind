/**
 * Drawing on the canvas: its tools, a second row of the tool island while Draw is on, and what a
 * pointer does with each. A tool
 * other than Select takes the left button on the canvas before anything under it sees it, so a
 * stroke can start over a terminal: on the window, ahead of React's own capture at its root, which
 * would start react-flow's drag selection. Wheel, middle and right button, and Space with the left,
 * still move the camera. Tiles take no pointer while a tool is on (`.hm-drawing`). What is drawn
 * goes on the board as any object does (useBoard), and an undo takes it back.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ElementType, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useReactFlow, useStore, useStoreApi, ViewportPortal, type InternalNode } from "@xyflow/react";
import { MAX_SHAPE_POINTS, SHAPE_COLORS, SHAPE_DASHES, SHAPE_WEIGHTS, isStroke, type ShapeColor, type ShapeDash, type ShapeForm, type ShapeObject, type ShapeWeight } from "@hivemind/workspace-doc/shapes";
import { shapeHit, shapeOutline, simplifyPoints, strokeBox, strokePixels, type Rect } from "@hivemind/workspace-doc/drawing";
import { dashPattern } from "@hivemind/workspace-doc/stroke-smooth";
import { rectOf } from "./Arrows";
import { fadingDrawn, repaintDrawn } from "./DrawnLayer";
import { ArrowUpRight, Circle, Diamond, Eraser, MessageSquare, Minus, Pencil, PointerArrow, RectangleShape, TextT } from "../components/icons";
import { Button } from "../components/ui/button";
import { actionKey } from "../shortcut";
import type { Action } from "../../../shared/keymap";
import { useBoardContext } from "./board-context";
import { drawnBox, hitTest, isBoxTool, snappedEnd, type BoxTool, type DrawTool, type Point } from "./board-model";
import { NoteDraft, type NoteAt } from "./BoardNotes";
import { inkVar } from "./shape-ink";
import { picturesIn, placePicture, usePictureInput } from "./board-images";
import { useChromeState } from "../workspace/chrome-store";

function Outline({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const MarkerIcon = () => <Outline><path d="M4 20h5l10-10-5-5L4 15z" /><path d="M13 6l5 5" /><path d="M3 22h8" /></Outline>;
const LaserIcon = () => <Outline><circle cx="12" cy="12" r="2.5" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></Outline>;
const MoreShapesIcon = () => <Outline><path d="M7 3l4.5 8h-9z" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1" /><circle cx="7" cy="17" r="4" /><path d="M17.2 13l4 4-4 4-4-4z" /></Outline>;
const TriangleIcon = () => <Outline><path d="M12 4l9 16H3z" /></Outline>;
const HexagonIcon = () => <Outline><path d="M7.5 4h9l4.5 8-4.5 8h-9L3 12z" /></Outline>;
const CylinderIcon = () => <Outline><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /></Outline>;
const CloudIcon = () => <Outline><path d="M7 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 9.2 4.4 4.4 0 0 1 17.5 18z" /></Outline>;
const StarIcon = () => <Outline><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9l-5.4 2.9 1.1-6.1-4.5-4.3 6.1-.8z" /></Outline>;
const ParallelogramIcon = () => <Outline><path d="M8 6h13l-5 12H3z" /></Outline>;

/** `key` is a shortcut the person can change; `letter` is one that is fixed. */
interface ToolButton { tool: DrawTool; label: string; icon: ElementType; key?: Action; letter?: string }

const TOOLS: ToolButton[] = [
  { tool: "select", label: "Select", icon: PointerArrow, key: "tool-select" },
  { tool: "pen", label: "Pen", icon: Pencil, key: "tool-pen" },
  { tool: "marker", label: "Marker", icon: MarkerIcon, letter: "M" },
  { tool: "rect", label: "Rectangle", icon: RectangleShape, key: "tool-rect" },
  { tool: "ellipse", label: "Ellipse", icon: Circle, key: "tool-ellipse" },
  { tool: "diamond", label: "Diamond", icon: Diamond, key: "tool-diamond" },
  { tool: "line", label: "Line", icon: Minus, key: "tool-line" },
  { tool: "arrow", label: "Arrow", icon: ArrowUpRight, key: "tool-arrow" },
  { tool: "text", label: "Text", icon: TextT, key: "tool-text" },
  { tool: "eraser", label: "Eraser", icon: Eraser, key: "tool-eraser" },
  { tool: "laser", label: "Laser pointer", icon: LaserIcon },
  { tool: "note", label: "Pin a note", icon: MessageSquare, key: "tool-note" },
];

const MORE_SHAPES: Array<ToolButton & { tool: BoxTool }> = [
  { tool: "triangle", label: "Triangle", icon: TriangleIcon },
  { tool: "hexagon", label: "Hexagon", icon: HexagonIcon },
  { tool: "cylinder", label: "Cylinder", icon: CylinderIcon },
  { tool: "cloud", label: "Cloud", icon: CloudIcon },
  { tool: "star", label: "Star", icon: StarIcon },
  { tool: "parallelogram", label: "Parallelogram", icon: ParallelogramIcon },
];
/** More shapes sits in the bar after the last shape that has a button of its own. */
const MORE_SHAPES_AFTER: DrawTool = "diamond";

const INKED: ReadonlySet<DrawTool> = new Set(TOOLS.concat(MORE_SHAPES).map((t) => t.tool).filter((t) => !["select", "eraser", "laser", "note"].includes(t)));
/** The tools whose strokes take the dash, weight and rough chosen in the bar. */
const STYLED: ReadonlySet<DrawTool> = new Set([...INKED].filter((t) => t !== "text" && t !== "marker"));
const LASER_MS = 1000;

/** How the next shape is drawn: chosen in the bar, kept for the window. */
export interface NextStyle { dash: ShapeDash; weight: ShapeWeight; rough: boolean }
let chosenStyle: NextStyle = { dash: "solid", weight: "medium", rough: false };
const styleWatchers = new Set<() => void>();
export function nextStyle(): NextStyle {
  return chosenStyle;
}
export function setNextStyle(change: Partial<NextStyle>): void {
  chosenStyle = { ...chosenStyle, ...change };
  for (const tell of styleWatchers) tell();
}
function watchNextStyle(tell: () => void): () => void {
  styleWatchers.add(tell);
  return () => { styleWatchers.delete(tell); };
}
/** The chosen style as a new shape stores it: solid and smooth are stored as nothing. */
function styleOfNext(): Pick<ShapeObject, "dash" | "weight" | "rough"> {
  const { dash, weight, rough } = chosenStyle;
  return { weight, ...(dash !== "solid" ? { dash } : {}), ...(rough ? { rough: true } : {}) };
}
const after = <T,>(all: readonly T[], one: T): T => all[(all.indexOf(one) + 1) % all.length]!;
const named = (word: string): string => word[0]!.toUpperCase() + word.slice(1);
const typingIn = (el: Element | null): boolean => !!el?.closest?.("input, textarea, select, [contenteditable]");

/** A click with no drag draws one of these. */
const CLICKED_SIZE = { w: 160, h: 96 };
const TEXT_SIZE = { w: 200, h: 36 };

/** What is being drawn now, in canvas coordinates. */
type Gesture =
  | { kind: "box"; form: ShapeForm; origin: Point; from: Point; to: Point }
  | { kind: "line"; arrow: boolean; points: Array<[number, number]> }
  | { kind: "pen"; marker: boolean; points: Array<[number, number]> }
  | { kind: "eraser" }
  | { kind: "laser" };
type Drawn = Exclude<Gesture, { kind: "eraser" | "laser" }>;

function boxOf(from: Point, to: Point): Rect {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

const ZOOM = (s: { transform: [number, number, number] }): number => s.transform[2];

export function DrawTools({ pane, repo, shown }: { pane: RefObject<HTMLElement | null>; repo: string | null; shown: boolean }) {
  const board = useBoardContext();
  const flow = useReactFlow();
  const flowStore = useStoreApi();
  const zoom = useStore(ZOOM);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [noteAt, setNoteAt] = useState<NoteAt | null>(null);
  /** The tool stays on after each shape: asked for by a double click on its button. */
  const [kept, setKept] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const style = useSyncExternalStore(watchNextStyle, nextStyle);
  const live = useRef({ board, gesture, zoom, kept });
  live.current = { board, gesture, zoom, kept };
  const space = useRef(false);
  const laser = useRef<HTMLCanvasElement | null>(null);
  const tool = board.tool;
  const { drawButton, drawRow, drawOptions, drawOpensUp } = useChromeState();
  const picking = useRef<HTMLInputElement>(null);
  const pictures = useRef({ board, toCanvas: flow.screenToFlowPosition });
  pictures.current = { board, toCanvas: flow.screenToFlowPosition };
  usePictureInput(pane, pictures);
  const picked = (files: FileList | null) => {
    const r = pane.current?.getBoundingClientRect();
    const at = flow.screenToFlowPosition(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 });
    picturesIn(files).forEach((file, i) => void placePicture(board, file, { x: at.x + i * 24, y: at.y + i * 24 }));
  };

  // Any other way of picking a tool is one use of it.
  useEffect(() => { setKept(false); setMoreOpen(false); }, [tool]);

  // The keys the keymap does not hold: M is the marker, and 1 to 7 pick the ink while a tool that takes ink is on.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typingIn(e.target as Element | null) || typingIn(document.activeElement)) return;
      if (!pane.current || pane.current.offsetParent === null) return;
      const b = live.current.board;
      const ink = INKED.has(b.tool) && /^[1-9]$/.test(e.key) ? SHAPE_COLORS[Number(e.key) - 1] : undefined;
      if (ink) b.setInk(ink);
      else if (e.key.toLowerCase() === "m" && !e.shiftKey) b.setTool("marker");
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [pane]);

  /** What is at a point on the canvas, front-most first: what an arrow or a note lands on. */
  const targetAt = (p: Point): { id: string; rect: Rect } | undefined => {
    const nodes = flow.getNodes()
      .map((n) => flow.getInternalNode(n.id))
      .filter((n): n is InternalNode => !!n)
      .sort((a, b) => b.internals.z - a.internals.z)
      .map((n) => ({ id: n.id, rect: rectOf(n) }));
    return hitTest(p, nodes);
  };

  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    const on = tool !== "select";
    el.classList.toggle("hm-drawing", on);
    el.dataset.drawingWith = tool;
    if (!on) return () => { el.classList.remove("hm-drawing"); };

    const keyDown = (e: KeyboardEvent) => { if (e.code === "Space") space.current = true; };
    const keyUp = (e: KeyboardEvent) => { if (e.code === "Space") space.current = false; };
    const at = (e: PointerEvent): Point => flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const mine = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    const onCanvas = (e: Event): boolean => {
      const target = e.target as Element | null;
      return !!target && el.contains(target) && !target.closest?.(".react-flow__panel, [data-note-card]");
    };
    // What the eraser went over in this drag: faded while it goes, taken away together when it lifts.
    const erasing = new Map<string, Element | null>();
    let erasedFrom: Point | null = null;
    const fade = (id: string, shown: Element | null) => {
      if (erasing.has(id)) return;
      erasing.set(id, shown);
      if (shown) shown.setAttribute("data-erasing", "");
      else { fadingDrawn.add(id); repaintDrawn(); }
    };
    const eraseTo = (p: Point) => {
      const z = live.current.zoom;
      const within = 8 / z;
      const from = erasedFrom ?? p;
      erasedFrom = p;
      // Every point along the way, so a quick swipe still meets a thin stroke it crosses.
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / within));
      const along = Array.from({ length: steps }, (_, i) => ({ x: from.x + ((p.x - from.x) * (i + 1)) / steps, y: from.y + ((p.y - from.y) * (i + 1)) / steps }));
      for (const n of flowStore.getState().nodes) {
        if (n.type !== "shape") continue;
        const o = (n.data as { object: ShapeObject }).object;
        if (!o.locked && !erasing.has(o.id) && along.some((q) => shapeHit(o, q, within))) fade(o.id, el.querySelector(`.react-flow__node[data-id="${CSS.escape(o.id)}"]`));
      }
      for (const path of el.querySelectorAll<SVGPathElement>("[data-board-arrow] [data-arrow-hit]")) {
        const arrow = path.closest("[data-board-arrow]")!;
        if (along.some((q) => path.isPointInStroke(new DOMPoint(q.x, q.y)))) fade(arrow.getAttribute("data-board-arrow")!, arrow);
      }
    };
    const eraseDone = (keep: boolean) => {
      for (const shown of erasing.values()) shown?.removeAttribute("data-erasing");
      fadingDrawn.clear();
      repaintDrawn();
      if (keep && erasing.size) live.current.board.remove(...erasing.keys());
      erasing.clear();
      erasedFrom = null;
    };
    let held: number | null = null;
    let frame = 0;
    const done = (b: typeof board) => { if (!live.current.kept) b.setTool("select"); };
    // The laser's trail, in the overlay's own pixels: nothing of it is kept once it has faded.
    const trail: Array<{ x: number; y: number; at: number; starts: boolean }> = [];
    let laserFrame = 0;
    const paintLaser = () => {
      laserFrame = 0;
      const canvas = laser.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const now = performance.now();
      while (trail.length && now - trail[0]!.at > LASER_MS) trail.shift();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round";
      ctx.lineWidth = 4 * (window.devicePixelRatio || 1);
      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue(inkVar("red").slice(4, -1)).trim();
      for (let i = 1; i < trail.length; i++) {
        const [a, c] = [trail[i - 1]!, trail[i]!];
        if (c.starts) continue;
        ctx.globalAlpha = 1 - (now - c.at) / LASER_MS;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (trail.length) laserFrame = requestAnimationFrame(paintLaser);
    };
    const laserTo = (e: PointerEvent, starts: boolean) => {
      const canvas = laser.current;
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      if (starts && (canvas.width !== Math.round(box.width * scale) || canvas.height !== Math.round(box.height * scale))) {
        canvas.width = Math.round(box.width * scale);
        canvas.height = Math.round(box.height * scale);
      }
      trail.push({ x: (e.clientX - box.left) * scale, y: (e.clientY - box.top) * scale, at: performance.now(), starts });
      if (!laserFrame) laserFrame = requestAnimationFrame(paintLaser);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || space.current || !onCanvas(e)) return;
      mine(e);
      const p = at(e);
      const { board: b } = live.current;
      switch (b.tool) {
        case "text":
          b.addShape({ form: "text", x: p.x, y: p.y - TEXT_SIZE.h / 2, ...TEXT_SIZE, text: "", color: b.ink }, "edit");
          done(b);
          return;
        case "note": {
          const on = targetAt(p);
          setNoteAt(on ? { on: on.id, x: p.x - on.rect.x, y: p.y - on.rect.y, canvas: p } : { x: p.x, y: p.y, canvas: p });
          return;
        }
        case "eraser":
          setGesture({ kind: "eraser" });
          eraseTo(p);
          break;
        case "laser":
          setGesture({ kind: "laser" });
          laserTo(e, true);
          break;
        case "pen":
        case "marker":
          setGesture({ kind: "pen", marker: b.tool === "marker", points: [[p.x, p.y]] });
          break;
        case "line":
        case "arrow":
          setGesture({ kind: "line", arrow: b.tool === "arrow", points: [[p.x, p.y], [p.x, p.y]] });
          break;
        default:
          if (!isBoxTool(b.tool)) return;
          setGesture({ kind: "box", form: b.tool, origin: p, from: p, to: p });
      }
      el.setPointerCapture(e.pointerId);
      held = e.pointerId;
    };
    const move = (e: PointerEvent) => {
      const g = live.current.gesture;
      if (held !== e.pointerId || !g) return;
      mine(e);
      const p = at(e);
      if (g.kind === "eraser") { eraseTo(p); return; }
      if (g.kind === "laser") { laserTo(e, false); return; }
      if (g.kind === "pen") {
        for (const c of e.getCoalescedEvents?.() ?? [e]) {
          const q = at(c);
          g.points.push([q.x, q.y]);
        }
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; setGesture((cur) => (cur === g ? { ...g } : cur)); });
        return;
      }
      if (g.kind === "line") {
        const end = e.shiftKey ? snappedEnd({ x: g.points[0]![0], y: g.points[0]![1] }, p) : p;
        setGesture({ ...g, points: [g.points[0]!, [end.x, end.y]] });
        return;
      }
      setGesture({ ...g, ...drawnBox(g.origin, p, { equal: e.shiftKey, centred: e.altKey }) });
    };
    const up = (e: PointerEvent) => {
      if (held !== e.pointerId) return;
      held = null;
      mine(e);
      cancelAnimationFrame(frame);
      frame = 0;
      el.releasePointerCapture(e.pointerId);
      const { board: b, gesture: g, zoom: z } = live.current;
      setGesture(null);
      if (!g) return;
      if (g.kind === "eraser") { eraseDone(true); return; }
      if (g.kind === "laser") return;
      if (g.kind === "pen") {
        g.points.push(g.points[g.points.length - 1]!);
        const box = strokeBox(simplifyPoints(g.points, 0.5 / z));
        b.addShape({ form: "pen", ...box, color: b.ink, ...(g.marker ? { marker: true } : styleOfNext()) });
        return;
      }
      if (g.kind === "line") {
        const [from, to] = [{ x: g.points[0]![0], y: g.points[0]![1] }, { x: g.points[1]![0], y: g.points[1]![1] }];
        if (Math.hypot(to.x - from.x, to.y - from.y) < 4 / z) return;
        const [a, c] = [targetAt(from), targetAt(to)];
        if (g.arrow && a && c && a.id !== c.id) {
          b.addArrow(a, c);
        } else {
          b.addShape({ form: "line", ...strokeBox(g.points), color: b.ink, ...styleOfNext(), ...(g.arrow ? { head: true } : {}) }, "select");
        }
        done(b);
        return;
      }
      if (g.kind === "box") {
        const r = boxOf(g.from, g.to);
        const clicked = r.w < 4 / z && r.h < 4 / z;
        const place = clicked ? { x: g.origin.x - CLICKED_SIZE.w / 2, y: g.origin.y - CLICKED_SIZE.h / 2, ...CLICKED_SIZE } : r;
        b.addShape({ form: g.form, ...place, color: b.ink, ...styleOfNext(), ...(b.filled ? { filled: true } : {}) }, "select");
        done(b);
      }
    };
    // A press that was ours ends in a click: nothing under it hears that either.
    const click = (e: MouseEvent) => {
      if (e.button === 0 && !space.current && onCanvas(e)) mine(e);
    };
    window.addEventListener("pointerdown", down, { capture: true });
    window.addEventListener("pointermove", move, { capture: true });
    window.addEventListener("pointerup", up, { capture: true });
    window.addEventListener("pointercancel", up, { capture: true });
    window.addEventListener("click", click, { capture: true });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(laserFrame);
      eraseDone(false);
      el.classList.remove("hm-drawing");
      window.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener("pointermove", move, { capture: true });
      window.removeEventListener("pointerup", up, { capture: true });
      window.removeEventListener("pointercancel", up, { capture: true });
      window.removeEventListener("click", click, { capture: true });
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [tool, pane, flow, flowStore]);

  // Leaving Pin a note leaves its draft.
  useEffect(() => { if (tool !== "note") setNoteAt(null); }, [tool]);

  const tools = TOOLS.filter((t) => t.tool !== "note" || repo);
  const toolButton = (t: ToolButton) => {
    const Icon = t.icon;
    const key = t.key ? actionKey(t.key) : t.letter;
    const on = tool === t.tool;
    const hint = t.tool === "select" || t.tool === "note" ? "" : on && kept ? "  Stays on" : "  Double-click to keep it on";
    return (
      <Button key={t.tool} variant={on ? "secondary" : "ghost"} size="icon-sm" aria-label={t.label} aria-pressed={on}
        className={on && kept ? "ring-2 ring-[var(--color-fg)]" : undefined} data-tool-kept={on && kept ? "" : undefined}
        title={`${key ? `${t.label}  (${key})` : t.label}${hint}`} data-draw-tool={t.tool}
        onClick={() => { setKept(false); board.setTool(board.tool === t.tool ? "select" : t.tool); }} onDoubleClick={() => { if (t.tool !== "select" && t.tool !== "note") setKept(true); }}>
        <Icon />
      </Button>
    );
  };
  const moreChosen = MORE_SHAPES.some((t) => t.tool === tool);
  return (
    <>
      {gesture && gesture.kind !== "eraser" && gesture.kind !== "laser" && <GesturePreview gesture={gesture} ink={board.ink} filled={board.filled} style={style} />}
      {tool === "laser" && <canvas ref={laser} className="pointer-events-none absolute inset-0 size-full" style={{ zIndex: 1100 }} data-laser-trail />}
      <input ref={picking} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-draw-image-file
        onChange={(e) => { picked(e.currentTarget.files); e.currentTarget.value = ""; }} />
      {noteAt && repo && <NoteDraft repo={repo} at={noteAt} onDone={() => { setNoteAt(null); board.setTool("select"); }} />}
      {shown && drawButton && createPortal(
        <Button variant={board.drawing ? "secondary" : "ghost"} size="icon" aria-label="Draw" aria-pressed={board.drawing} data-draw-toggle
          title={`Draw  (${actionKey("toggle-drawing")})`} onClick={() => board.setDrawing(!board.drawing)}>
          <Pencil />
        </Button>,
        drawButton,
      )}
      {shown && drawRow && createPortal(
        // Kept while Draw is off, collapsed, so the island is as wide either way.
        <div role="toolbar" aria-label="Drawing tools" data-draw-tools inert={!board.drawing}
          className={`flex items-center gap-0.5 ${board.drawing ? "mt-1 border-t border-[var(--color-line2)] pt-1" : "invisible h-0 overflow-hidden"}`}>
          {tools.map((t) => (t.tool !== MORE_SHAPES_AFTER ? toolButton(t) : (
            <span key={t.tool} className="relative flex items-center gap-0.5">
              {toolButton(t)}
              <Button variant={moreChosen ? "secondary" : "ghost"} size="icon-sm" aria-label="More shapes" aria-haspopup="true" aria-expanded={moreOpen}
                className={moreChosen && kept ? "ring-2 ring-[var(--color-fg)]" : undefined} title={moreChosen && kept ? "More shapes  Stays on" : "More shapes  Double-click to keep the chosen one on"} data-draw-more
                onClick={() => setMoreOpen(!moreOpen)} onDoubleClick={() => { if (moreChosen) setKept(true); }}>
                <MoreShapesIcon />
              </Button>
              {moreOpen && (
                <div className={`hm-island absolute left-0 z-10 flex ${drawOpensUp ? "bottom-full mb-2" : "top-full mt-2"} items-center gap-0.5 rounded-xl p-1`} role="group" aria-label="More shapes" data-draw-more-shapes
                  onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMoreOpen(false); } }}>
                  {MORE_SHAPES.map(toolButton)}
                  <Button variant="ghost" size="xs" className="border-l border-[var(--color-line2)] pl-2" title="Put a picture on the board (or paste or drop one on the canvas)" data-draw-image
                    disabled={!repo} onClick={() => { setMoreOpen(false); picking.current?.click(); }}>Image…</Button>
                </div>
              )}
            </span>
          )))}
        </div>,
        drawRow,
      )}
      {shown && board.drawing && drawOptions && !moreOpen && (INKED.has(tool) || STYLED.has(tool)) && createPortal(
        <div className="hm-island flex items-center gap-0.5 rounded-xl p-1" role="group" aria-label="What is drawn next" data-draw-options>
          {INKED.has(tool) && (
            <div className="flex items-center gap-1 px-1" data-draw-inks>
              {SHAPE_COLORS.map((c, i) => <InkButton key={c} color={c} chosen={board.ink === c} onChoose={board.setInk} letter={i < 9 ? String(i + 1) : undefined} />)}
              {isBoxTool(tool) && (
                <Button variant={board.filled ? "secondary" : "ghost"} size="xs" aria-pressed={board.filled} data-draw-fill onClick={() => board.setFilled(!board.filled)}>Fill</Button>
              )}
            </div>
          )}
          {STYLED.has(tool) && (
            <div className="flex items-center gap-0.5 border-l border-[var(--color-line2)] pl-1" data-draw-style>
              <Button variant="ghost" size="xs" title="Line: solid, dashed or dotted" data-draw-dash={style.dash} onClick={() => setNextStyle({ dash: after(SHAPE_DASHES, style.dash) })}>{named(style.dash)}</Button>
              <Button variant="ghost" size="xs" title="Line weight: thin, medium or thick" data-draw-weight={style.weight} onClick={() => setNextStyle({ weight: after(SHAPE_WEIGHTS, style.weight) })}>{named(style.weight)}</Button>
              <Button variant={style.rough ? "secondary" : "ghost"} size="xs" aria-pressed={style.rough} title="Hand-drawn look" data-draw-rough onClick={() => setNextStyle({ rough: !style.rough })}>Rough</Button>
            </div>
          )}
        </div>,
        drawOptions,
      )}
    </>
  );
}

export function InkButton({ color, chosen, onChoose, letter }: { color: ShapeColor; chosen: boolean; onChoose: (color: ShapeColor) => void; letter?: string }) {
  return (
    <button type="button" aria-label={`${color} ink`} aria-pressed={chosen} data-draw-ink={color} title={letter ? `${named(color)}  (${letter})` : named(color)}
      className={`size-4 rounded-full border-2 ${chosen ? "border-[var(--color-fg)]" : "border-transparent"}`}
      style={{ background: inkVar(color) }} onClick={() => onChoose(color)} />
  );
}

/** What is being drawn, before it is on the board. */
function GesturePreview({ gesture, ink, filled, style }: { gesture: Drawn; ink: ShapeColor; filled: boolean; style: NextStyle }) {
  const preview = (() => {
    if (gesture.kind === "box") {
      const r = boxOf(gesture.from, gesture.to);
      return { ...r, d: shapeOutline({ form: gesture.form, w: r.w, h: r.h }), head: false };
    }
    const points = gesture.points.slice(-MAX_SHAPE_POINTS);
    const box = strokeBox(points);
    return { ...box, d: shapeOutline({ form: gesture.kind === "pen" ? "pen" : "line", w: box.w, h: box.h, points: box.points }), head: gesture.kind === "line" && gesture.arrow };
  })();
  const color = inkVar(ink);
  const stroked = gesture.kind !== "box" || isStroke(gesture.form);
  const marker = gesture.kind === "pen" && gesture.marker;
  const px = marker ? strokePixels(undefined) * 7 : strokePixels(style.weight);
  const dashes = marker ? [] : dashPattern(style.dash, px);
  return (
    <ViewportPortal>
      <svg className="pointer-events-none absolute overflow-visible" style={{ left: preview.x, top: preview.y, zIndex: 1100 }} width={Math.max(preview.w, 1)} height={Math.max(preview.h, 1)} data-draw-preview>
        {preview.head && (
          <defs>
            <marker id="hm-draft-head" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: color }} />
            </marker>
          </defs>
        )}
        <path d={preview.d} style={{ stroke: color }} strokeWidth={px} strokeOpacity={marker ? 0.35 : undefined} strokeDasharray={dashes.length ? dashes.join(" ") : undefined} strokeLinecap="round" strokeLinejoin="round"
          fill={!stroked && filled ? color : "none"} fillOpacity={!stroked && filled ? 0.14 : undefined} markerEnd={preview.head ? "url(#hm-draft-head)" : undefined} />
      </svg>
    </ViewportPortal>
  );
}
