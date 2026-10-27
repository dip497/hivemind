import { useEffect, useState, type CSSProperties, type RefObject } from "react";

const listeners = new Set<() => void>();

/** A view that scales its tiles (the canvas zooming) calls this whenever the scale may have changed. */
export function tileScaleMayHaveChanged(): void {
  for (const listener of listeners) listener();
}

/** How much the element is scaled on screen, read once the view has been still for `settleMs`.
 *  It stays at the old value while the view moves, so a tile that redraws at this scale does so
 *  once per gesture, not every frame. */
export function useScaleOnScreen(ref: RefObject<HTMLElement | null>, settleMs = 150): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const width = el.offsetWidth;
      if (!width) return;
      const next = Math.round((el.getBoundingClientRect().width / width) * 1000) / 1000;
      setScale((prev) => (prev === next ? prev : next));
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, settleMs);
    };
    listeners.add(later);
    // Moving the tile into another view, or resizing it, shows up as a resize.
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    measure();
    return () => {
      listeners.delete(later);
      resize.disconnect();
      clearTimeout(timer);
    };
  }, [ref, settleMs]);
  return scale;
}

/** While `on`, a tile scrolled out of its view is drawn inside it, unseen and untouchable, so a
 *  page in it that someone elsewhere watches keeps drawing. `ref` is the tile's place, never moved;
 *  the returned style goes on what it holds. */
export function useDrawnOutOfView(ref: RefObject<HTMLElement | null>, on: boolean): CSSProperties | undefined {
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) { setOffset(null); return; }
    const view = el.closest<HTMLElement>(".react-flow");
    const place = () => {
      const r = el.getBoundingClientRect();
      const v = view?.getBoundingClientRect() ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      if (r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom) { setOffset(null); return; }
      const scale = el.offsetWidth ? r.width / el.offsetWidth : 1;
      setOffset({ x: (v.left - r.left) / scale, y: (v.top - r.top) / scale });
    };
    place();
    listeners.add(place);
    const resize = new ResizeObserver(place);
    if (view) resize.observe(view);
    return () => { listeners.delete(place); resize.disconnect(); };
  }, [ref, on]);
  return offset ? { transform: `translate(${offset.x}px, ${offset.y}px)`, opacity: 0, pointerEvents: "none" } : undefined;
}
