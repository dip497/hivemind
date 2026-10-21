/**
 * The workspace's widgets, over every view: cards the person drags anywhere on the screen, above
 * everything, staying put whatever the view does. Which widgets there are is the workspace's (and
 * everyone in it sees them); where each card sits, and whether they are hidden, is this person's
 * own, kept on this machine, since every screen differs. A new card starts at the right edge, or the
 * left over a view that asks for it (`"widgets": "left"` in its manifest). They
 * are added from the toolbar's Add menu, in any view.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { EyeOff, LayoutGrid, Settings2, X } from "../components/icons";
import type { WidgetObject } from "@hivemind/workspace-doc/shapes";
import type { WidgetPackage } from "../../../shared/ipc";
import { SettingsForm } from "../plugins/SettingsForm";
import { Button } from "../components/ui/button";
import { widgetsOf } from "./board-model";
import type { Board } from "./useBoard";
import { WidgetContent, useWidgetLook } from "./WidgetBody";
import { clickWidget, optionsOf, useDrawn } from "./widget-runtime";
import { CARD_W, stackDownEdge, type Size, type Spot } from "./widget-stack";

const posKey = (repo: string) => `hivemind:widget-spots:${repo}`;
const HIDDEN = "hivemind:widgets-hidden";
function readJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept: still placed now */ }
}

/** `spot` kept on the screen, whatever its size now: a card as wide as it is drawn, else a card's width. */
const onScreen = (spot: Spot, size?: Size): Spot => ({
  x: Math.min(Math.max(spot.x, 0), Math.max(window.innerWidth - (size?.w ?? CARD_W), 0)),
  y: Math.min(Math.max(spot.y, 0), Math.max(window.innerHeight - 48, 0)),
});

export function WidgetLayer({ repo, board, packages, edge }: {
  repo: string | null;
  /** The screen edge cards nobody has moved stack down: the active view's choice. */
  edge: "left" | "right";
  board: Pick<Board, "objects" | "remove" | "update" | "edit">;
  packages: WidgetPackage[];
}) {
  const [spots, setSpots] = useState<Record<string, Spot>>({});
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [hidden, setHidden] = useState(() => readJson(HIDDEN, false));
  const [, setSize] = useState(0);
  useEffect(() => { setSpots(repo ? readJson(posKey(repo), {}) : {}); }, [repo]);
  useEffect(() => {
    const resized = () => setSize((n) => n + 1);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);

  const widgets = widgetsOf(board.objects);
  const nameOf = (id: string) => packages.find((p) => p.id === id)?.name ?? id;
  const place = (id: string, spot: Spot, keep: boolean) => {
    setSpots((all) => {
      const next = { ...all, [id]: spot };
      if (keep && repo) writeJson(posKey(repo), next);
      return next;
    });
  };
  const hide = (value: boolean) => { setHidden(value); writeJson(HIDDEN, value); };
  const sized = (id: string, size: Size) => setSizes((all) => {
    const was = all[id];
    return was && was.w === size.w && was.h === size.h ? all : { ...all, [id]: size };
  });
  const stacked = stackDownEdge(widgets.map((w) => w.id), sizes, { w: window.innerWidth, h: window.innerHeight }, edge);

  if (!repo || widgets.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-(--layer-widgets)" data-widget-layer={hidden ? "hidden" : "shown"}>
      {!hidden && widgets.map((w) => (
        <WidgetCard key={w.id} object={w} pkg={packages.find((p) => p.id === w.widget)} name={nameOf(w.widget)} onEdit={() => board.edit(w.id)}
          spot={onScreen(spots[w.id] ?? stacked[w.id]!, sizes[w.id])} onMove={place} onSize={sized} onRemove={() => board.remove(w.id)}
          onOption={(option, value) => board.update(w.id, (o) => (o.kind === "widget" ? { ...o, options: { ...o.options, [option]: value } } : o))} />
      ))}
      <div className="pointer-events-auto absolute bottom-4 right-4">
        <Button variant="ghost" size="icon" className="hm-island rounded-xl" data-widgets-toggle
          aria-label={hidden ? `show widgets (${widgets.length})` : "hide widgets"} title={hidden ? "Show widgets" : "Hide widgets"}
          onClick={() => hide(!hidden)}>{hidden ? <LayoutGrid /> : <EyeOff />}</Button>
      </div>
    </div>
  );
}

function WidgetCard({ object, pkg, name, spot, onMove, onSize, onRemove, onOption, onEdit }: {
  object: WidgetObject; pkg: WidgetPackage | undefined; name: string; spot: Spot;
  onMove: (id: string, spot: Spot, keep: boolean) => void; onSize: (id: string, size: Size) => void; onRemove: () => void;
  onOption: (option: string, value: unknown) => void;
  onEdit: () => void;
}) {
  const id = object.id;
  const drawing = useDrawn(id);
  const bare = drawing?.chrome === "none";
  // A tinted widget is its note colour, as it is on the board.
  const { tint } = useWidgetLook(object, pkg);
  const el = useRef<HTMLDivElement>(null);
  const [setting, setSetting] = useState(false);
  // How long the move under way glides for: a widget's own move animates, a drag does not.
  const [glide, setGlide] = useState(0);
  const applied = useRef<number | null>(null);
  const drag = useRef<{ dx: number; dy: number; x: number; y: number; moved: boolean } | null>(null);

  // Its drawn size, so the cards stacked under it start below it however tall it grows.
  useEffect(() => {
    const card = el.current;
    if (!card) return;
    const measure = () => onSize(id, { w: card.offsetWidth, h: card.offsetHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(card);
    return () => watch.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // A move the widget asked for: every viewer glides its card there, on its own screen's size.
  const asked = drawing?.move;
  useEffect(() => {
    if (!asked || asked.n === applied.current) return;
    const first = applied.current === null;
    applied.current = asked.n;
    const w = el.current?.offsetWidth ?? CARD_W;
    const h = el.current?.offsetHeight ?? 48;
    setGlide(first ? 0 : asked.over);
    onMove(id, { x: asked.x * Math.max(window.innerWidth - w, 0), y: asked.y * Math.max(window.innerHeight - h, 0) }, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked?.n]);

  const drawnSize = (): Size | undefined => (el.current ? { w: el.current.offsetWidth, h: el.current.offsetHeight } : undefined);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Its buttons, options and what is written in it are pressed, not dragged.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, label, textarea, [role=checkbox]")) return;
    setGlide(0);
    drag.current = { dx: e.clientX - spot.x, dy: e.clientY - spot.y, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    onMove(id, onScreen({ x: e.clientX - d.dx, y: e.clientY - d.dy }, drawnSize()), false);
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Pressed and let go where it was: a click, which the widget's code hears.
    if (!d.moved) { clickWidget(id); return; }
    onMove(id, onScreen(spot, drawnSize()), true);
  };
  return (
    <div ref={el} data-widget={object.widget} data-widget-chrome={bare ? "none" : "card"} aria-label={name}
      className={`group pointer-events-auto absolute flex cursor-grab flex-col active:cursor-grabbing ${bare ? "" : tint ? "rounded-md p-3 shadow-[var(--hm-shadow-2)]" : "hm-island rounded-xl p-3"}`}
      // Moved by transform, so the GPU glides it: a moving left/top lays out and repaints every frame.
      style={{ left: 0, top: 0, transform: `translate3d(${spot.x}px, ${spot.y}px, 0)`, ...(bare ? {} : { width: CARD_W }), ...(tint && !bare ? { background: tint, color: "var(--color-note-ink)" } : {}), ...(glide ? { transition: `transform ${glide}ms linear` } : {}) }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => { if (!setting) onEdit(); }}>
      <div className={`absolute right-1 top-1 z-10 gap-0.5 ${setting ? "flex" : "hidden group-hover:flex"} ${bare ? "hm-island rounded-md" : ""}`}>
        {!!pkg?.options.length && <Button variant="ghost" size="icon-xs" aria-label={`${name} options`} aria-pressed={setting} data-widget-options
          onClick={() => setSetting((v) => !v)}><Settings2 /></Button>}
        <Button variant="ghost" size="icon-xs" aria-label={`remove ${name}`} onClick={onRemove}><X /></Button>
      </div>
      {setting && pkg
        ? <div className={bare ? "hm-island w-[240px] rounded-xl p-3" : ""}><SettingsForm compact fields={pkg.options} values={optionsOf(pkg, object)} onChange={onOption} /></div>
        : <WidgetContent object={object} pkg={pkg} />}
    </div>
  );
}
