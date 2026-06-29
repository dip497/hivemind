/**
 * Shared tile fit-to-screen fullscreen — one component + one hook reused by every
 * tile kind, so the look (a frosted glass panel floating over a clean copy of the
 * live wallpaper) and the behavior (Esc to exit, font A−/A+) stay identical
 * whether you fullscreen a terminal, an editor, or a diff.
 *
 * Two integration styles, both filling the SAME `hostRef` glass panel:
 *   • Imperative content (xterm element, CodeMirror `view.dom`): call
 *     `useReparentFullscreen` to MOVE the live node into the panel and back — the
 *     node keeps its state because we only change its DOM parent (we hold the ref,
 *     so it survives the overlay unmounting).
 *   • React content (Pierre `<CodeView>`): render it through `createPortal` into
 *     `hostRef.current` while open — switching the portal container preserves the
 *     component's state.
 */
import { useEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Wallpaper } from "./Wallpaper";
import type { TileFont } from "./tile-font";

/** Font A−/A+ for the (dark, on-wallpaper) fullscreen header. Font density only —
 *  in fullscreen the tile already fills the screen, so tile SCALE is moot. */
function FsFontButtons({ font }: { font: TileFont }) {
  return (
    <span
      className="nodrag inline-flex items-center rounded border border-white/20 overflow-hidden"
      title="Font size (Ctrl/Cmd ±)"
    >
      <button
        onClick={font.dec}
        className="px-1.5 text-[10px] leading-none text-white/80 hover:bg-white/10 hover:text-white transition-colors h-5 grid place-items-center"
        aria-label="decrease font size"
      >
        A−
      </button>
      <button
        onClick={font.inc}
        className="px-1.5 text-[11px] leading-none text-white/80 hover:bg-white/10 hover:text-white transition-colors h-5 grid place-items-center border-l border-white/20"
        aria-label="increase font size"
      >
        A+
      </button>
    </span>
  );
}

/**
 * The fullscreen chrome. Portaled to document.body so it escapes react-flow's CSS
 * transform; renders a clean embedded wallpaper behind a frosted glass panel whose
 * `hostRef` div the caller fills (reparent or portal). Esc closes.
 */
export function FullscreenShell({
  title,
  font,
  hostRef,
  onClose,
  children,
}: {
  title: string;
  font: TileFont;
  hostRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** React content to render INSIDE the glass panel (Pierre CodeView etc.). Omit
   *  for imperative tiles that fill the panel via `useReparentFullscreen`. */
  children?: ReactNode;
}) {
  // Esc exits — capture phase so it wins before an inner editor/terminal eats it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-hidden">
      <Wallpaper embedded />
      <div className="relative z-10 flex h-full w-full flex-col gap-2 p-3">
        <div className="h-7 flex items-center gap-2 px-1 text-[11px] font-mono text-white/85 shrink-0">
          <span className="font-semibold text-white/95">{title}</span>
          <span className="ml-auto flex items-center gap-2">
            <FsFontButtons font={font} />
            <button
              onClick={onClose}
              className="nodrag rounded border border-white/20 px-1.5 h-5 grid place-items-center text-[10px] text-white/85 hover:bg-white/10 hover:text-white transition-colors"
              title="Exit fullscreen (Esc)"
            >
              Esc ✕
            </button>
          </span>
        </div>
        {/* Frosted glass panel — same content tint + blur recipe as the canvas
            tiles (.hm-term-fs-panel), so fullscreen matches the tile you came from.
            The caller fills this via reparent (imperative) or portal (React). */}
        <div
          ref={hostRef}
          style={{ fontSize: `${font.size}px` }}
          className="hm-term-fs-panel relative flex-1 min-h-0 min-w-0 overflow-hidden rounded-xl p-2 border border-[var(--color-line)]"
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Move an imperatively-managed live DOM node (xterm element / CodeMirror view.dom)
 * between its home host and the fullscreen panel as `open` flips, WITHOUT
 * recreating it — we hold the node reference, so it survives the overlay
 * mounting/unmounting; only its DOM parent changes (state + scrollback preserved).
 * `afterMove` runs on the next frame (refit to the new box, refocus).
 */
export function useReparentFullscreen(opts: {
  open: boolean;
  node: () => HTMLElement | null | undefined;
  homeRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<HTMLElement | null>;
  afterMove?: () => void;
}) {
  const { open, node, homeRef, hostRef, afterMove } = opts;
  useEffect(() => {
    const el = node();
    if (!el) return;
    const dest = open ? hostRef.current : homeRef.current;
    if (dest && el.parentElement !== dest) dest.appendChild(el);
    const raf = requestAnimationFrame(() => { try { afterMove?.(); } catch { /* torn down */ } });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
