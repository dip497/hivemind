import { useEffect, useState, type RefObject } from "react";

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
