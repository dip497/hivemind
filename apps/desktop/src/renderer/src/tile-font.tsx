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
 * Terminal scale control — A−/A+ buttons that scale the WHOLE terminal in
 * proportion (font px AND the tile node box grow together via `onScale`), so it
 * stays crisp: nothing zooms, the bigger box just fits more cols/rows at 100%
 * canvas zoom. The numeric chip clicks to the screen's best size, double-clicks
 * to the kind default. `nodrag` everywhere so clicks never start a tile drag.
 */
export function FontScaleControl({
  size, reset, set, best, onScale,
}: TileFont & {
  /** Step delta as a ratio (new/old) so the host can scale the whole tile node
   *  in proportion with the font — passed by TerminalTile, omitted elsewhere. */
  onScale?: (ratio: number) => void;
}) {
  const step = (dir: 1 | -1) => {
    const next = Math.max(MIN, Math.min(MAX, size + dir));
    if (onScale && size > 0 && next !== size) onScale(next / size);
    set(next);
  };
  return (
    <span className="nodrag inline-flex items-center rounded bg-[var(--color-bg)] border border-[var(--color-line2)] overflow-hidden">
      <button
        onClick={() => step(-1)}
        className="px-1 text-[11px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
        title="Scale the whole terminal down"
        aria-label="scale terminal down"
      >
        −
      </button>
      <button
        onClick={best}
        onDoubleClick={reset}
        className="px-1 text-[9px] leading-none tabular-nums text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center border-x border-[var(--color-line2)]"
        title="Best size for this screen · double-click = default"
      >
        {size}
      </button>
      <button
        onClick={() => step(1)}
        className="px-1 text-[11px] leading-none text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors h-4 grid place-items-center"
        title="Scale the whole terminal up"
        aria-label="scale terminal up"
      >
        +
      </button>
    </span>
  );
}
