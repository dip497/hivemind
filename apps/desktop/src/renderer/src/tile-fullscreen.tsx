/**
 * Shared tile fit-to-screen fullscreen — one component + one hook reused by every
 * tile kind, so the look (a frosted glass panel floating over a clean copy of the
 * live wallpaper) and the behavior (the keys that leave, font A−/A+) stay identical
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
import { actionKey, onShortcut } from "./shortcut";
import { useEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Wallpaper } from "./Wallpaper";
import type { TileFont } from "./tile-font";
import { setWorkspaceOccluded } from "./workspace-occlusion";

/** Font A−/A+ for the fullscreen header. Font density only —
 *  in fullscreen the tile already fills the screen, so tile SCALE is moot. */
function FsFontButtons({ font }: { font: TileFont }) {
  return (
    <span
      className="nodrag inline-flex items-center rounded border border-[var(--color-line2)] overflow-hidden"
      title={`Font size (${actionKey("font-bigger")} / ${actionKey("font-smaller")})`}
    >
      <button
        onClick={font.dec}
        className="px-1.5 text-chip leading-none text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] transition-colors h-5 grid place-items-center"
        aria-label="decrease font size"
      >
        A−
      </button>
      <button
        onClick={font.inc}
        className="px-1.5 text-count leading-none text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] transition-colors h-5 grid place-items-center border-l border-[var(--color-line2)]"
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
 * `hostRef` div the caller fills (reparent or portal). Esc (outside a terminal or field) or the
 * fit-to-screen key closes.
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
  // Esc leaves when nothing inside is typed into (a terminal's program keeps its Esc); ⌘/Ctrl ⇧ F
  // leaves from anywhere.
  useEffect(() => {
    const offEsc = onShortcut("leave-fullscreen", onClose);
    const offFit = onShortcut("fit-to-screen", onClose);
    return () => { offEsc(); offFit(); };
  }, [onClose]);

  // Covers the workspace: its full-window wallpaper stops decoding underneath.
  useEffect(() => {
    setWorkspaceOccluded(true, "fullscreen");
    return () => setWorkspaceOccluded(false, "fullscreen");
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-(--layer-fullscreen-tile) overflow-hidden bg-[var(--color-bg)]">
      <Wallpaper embedded covering />
      <div className="relative z-10 flex h-full w-full flex-col gap-2 p-3">
        <div className="h-7 flex items-center gap-2 px-1 text-count font-mono text-[var(--color-fg2)] shrink-0">
          <span className="font-semibold text-[var(--color-fg)]">{title}</span>
          <span className="ml-auto flex items-center gap-2">
            <FsFontButtons font={font} />
            <button
              onClick={onClose}
              className="nodrag rounded border border-[var(--color-line2)] px-1.5 h-5 grid place-items-center text-chip text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] transition-colors"
              title="Leave fullscreen"
            >
              {/* Esc leaves too, but not from inside a terminal or an editor: this key does. */}
              {actionKey("fit-to-screen")} ✕
            </button>
          </span>
        </div>
        {/* The tile's own background (.hm-term-fs-panel), so fullscreen looks like the tile you came from.
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
