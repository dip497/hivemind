/**
 * Per-node font sizing — each tile remembers its OWN font size (persisted by
 * tileId), adjustable via A−/A+ header buttons and Ctrl/Cmd +/−/0 when focused.
 *
 * Every tile kind applies the size differently (xterm option, a CSS var, a
 * CodeMirror theme, a CSS zoom), so this module only owns the shared STATE +
 * controls; each tile reads `size` and applies it however it renders.
 */
import { useCallback, useEffect, useState } from "react";
import { MIN_FONT as MIN, MAX_FONT as MAX, clampFont, optimalFontForScreen } from "./tile-font-calc";

export { optimalFontForScreen } from "./tile-font-calc";

const KEY = (id: string) => `hm:tileFont:${id}`;

export interface TileFont {
  size: number;
  inc: () => void;
  dec: () => void;
  reset: () => void;
  /** Set an explicit size (slider drag); clamped to the px range. */
  set: (n: number) => void;
  /** Grow the font to the optimal size for the current screen (crisp fit). */
  best: () => void;
}

/** Per-tile font size, persisted under the tile id. `def` is the kind's default. */
export function useTileFont(tileId: string, def: number): TileFont {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(KEY(tileId)));
      if (Number.isFinite(v) && v >= MIN && v <= MAX) return v;
    } catch { /* localStorage blocked */ }
    return def;
  });
  useEffect(() => {
    try { localStorage.setItem(KEY(tileId), String(size)); } catch { /* ignore */ }
  }, [tileId, size]);
  const inc = useCallback(() => setSize((s) => clampFont(s + 1)), []);
  const dec = useCallback(() => setSize((s) => clampFont(s - 1)), []);
  const reset = useCallback(() => setSize(def), [def]);
  const set = useCallback((n: number) => setSize(clampFont(n)), []);
  const best = useCallback(() => setSize(optimalFontForScreen()), []);
  return { size, inc, dec, reset, set, best };
}

/** Ctrl/Cmd +/−/0 → inc/dec/reset. Returns true if it handled the event. */
export function handleFontKey(
  e: { ctrlKey: boolean; metaKey: boolean; key: string; preventDefault: () => void },
  f: Pick<TileFont, "inc" | "dec" | "reset">,
): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.key === "=" || e.key === "+") { e.preventDefault(); f.inc(); return true; }
  if (e.key === "-" || e.key === "_") { e.preventDefault(); f.dec(); return true; }
  if (e.key === "0") { e.preventDefault(); f.reset(); return true; }
  return false;
}

/** A−/A+ header control. `nodrag` so clicks don't start a tile drag. */
export function FontStepper({ size, inc, dec, reset }: TileFont) {
  return (
    <span className="nodrag inline-flex items-center rounded bg-[var(--color-bg)] border border-[var(--color-line2)] overflow-hidden">
      <button
        onClick={dec}
        className="px-1 text-[10px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
        title="Smaller font (Ctrl/Cmd −)"
        aria-label="decrease font size"
      >
        A−
      </button>
      <button
        onClick={reset}
        className="px-1 text-[9px] leading-none tabular-nums text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center border-x border-[var(--color-line2)]"
        title="Reset font size (Ctrl/Cmd 0)"
      >
        {size}
      </button>
      <button
        onClick={inc}
        className="px-1 text-[11px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
        title="Larger font (Ctrl/Cmd +)"
        aria-label="increase font size"
      >
        A+
      </button>
    </span>
  );
}

/**
 * Hover-revealed scale slider for the terminal header. The slider is collapsed
 * (width 0) by default and expands on header hover — so it stays out of the way
 * yet gives a continuous, crisp scale control (font px → cols/rows) without
 * leaving 100% canvas zoom. The numeric chip = current px AND a one-click "best
 * for this screen" reset; A−/A+ remain for keyboard-free fine steps.
 *
 * Mounts inside a `group`-classed header so the `group-hover:` width transition
 * fires. `nodrag` everywhere so dragging the slider never starts a tile drag.
 */
export function FontScaleControl({ size, inc, dec, reset, set, best }: TileFont) {
  return (
    <span className="nodrag inline-flex items-center gap-1">
      <input
        type="range"
        min={MIN}
        max={MAX}
        step={1}
        value={size}
        onChange={(e) => set(Number(e.target.value))}
        onDoubleClick={best}
        aria-label="terminal font scale"
        title="Drag to scale (crisp) · double-click = best for screen"
        className="hm-font-slider nodrag h-1 w-0 opacity-0 group-hover:w-20 group-hover:opacity-100 transition-[width,opacity] duration-150 cursor-ew-resize accent-[var(--color-accent)]"
      />
      <span className="nodrag inline-flex items-center rounded bg-[var(--color-bg)] border border-[var(--color-line2)] overflow-hidden">
        <button
          onClick={dec}
          className="px-1 text-[10px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
          title="Smaller font (Ctrl/Cmd −)"
          aria-label="decrease font size"
        >
          A−
        </button>
        <button
          onClick={best}
          onDoubleClick={reset}
          className="px-1 text-[9px] leading-none tabular-nums text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center border-x border-[var(--color-line2)]"
          title="Best size for this screen (Ctrl/Cmd ⇧0) · double-click = default"
        >
          {size}
        </button>
        <button
          onClick={inc}
          className="px-1 text-[11px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
          title="Larger font (Ctrl/Cmd +)"
          aria-label="increase font size"
        >
          A+
        </button>
      </span>
    </span>
  );
}
