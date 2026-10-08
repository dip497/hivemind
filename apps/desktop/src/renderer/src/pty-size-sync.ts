/**
 * Keep the PTY's size equal to the terminal's, as an invariant rather than an
 * event; and, where the session's size is someone else's, draw it at theirs.
 *
 * xterm's `onResize` fires only when ITS OWN cols/rows change. Every path that
 * can leave the pty at a different size than the grid therefore goes unnoticed:
 * a re-attach (the daemon keeps the session's original spec), a fit that lands
 * on the cols the terminal already had, a deferred fit applied while the tile
 * was hidden, or a resize another mount of the same session sent. The pty then
 * wraps at one width while the grid renders at another — long lines run past
 * the right edge and a TUI's own chrome is drawn at the stale width.
 *
 * So: after every fit, ask what still needs sending. State is what we last sent
 * for this pty, not what xterm last emitted.
 */
export interface PtySize {
  cols: number;
  rows: number;
}

/**
 * The size to push to the pty, or null when it already has it. A zero/NaN
 * dimension means the grid is not laid out yet (a hidden or unmounted host);
 * sending it would resize the session to nothing.
 */
export function nextPtySize(last: PtySize | null, cols: number, rows: number): PtySize | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
  if (last && last.cols === cols && last.rows === rows) return null;
  return { cols, rows };
}

/** The longest a resize burst holds back the pty's resize. */
export const PTY_RESIZE_SETTLE_MS = 120;

/**
 * A pty resize that waits for a burst to settle. A drag or a window resize refits every frame; an
 * agent that redraws on each SIGWINCH then draws at widths already gone, and the leftovers stay on
 * screen. The grid follows every frame; the pty hears the last size, once. `now` sends what is
 * pending at once (a tile shown, keys taken).
 */
export function settledResize(send: (size: PtySize) => void, settleMs = PTY_RESIZE_SETTLE_MS) {
  let pending: PtySize | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const size = pending;
    pending = null;
    if (size) send(size);
  };
  return {
    request(size: PtySize): void {
      pending = size;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, settleMs);
    },
    now: flush,
    cancel(): void { if (timer) clearTimeout(timer); timer = null; pending = null; },
  };
}

/**
 * The grid a window draws a terminal at (R4, M2). Several windows, on this machine or others, may
 * show one session, and only one of them sizes it: the one typing into it here, or a guest holding
 * its keyboard. While the session has a size this window asked for (`asked`: its last few asks),
 * the window's size is the session's and it draws `own`, what fits its tile; otherwise it draws the
 * session at the size it was given, which it letterboxes, or scales down when that is the larger
 * (`scaleToFit`). With no size heard, its own.
 */
export function drawnSize(own: PtySize, asked: readonly PtySize[], session: PtySize | null): PtySize {
  if (!session || asked.some((a) => a.cols === session.cols && a.rows === session.rows)) return own;
  return session;
}

/** How much a grid drawn at `drawn` is scaled down to fit a tile that fits `own`: 1 when it fits. */
export function scaleToFit(own: PtySize, drawn: PtySize): number {
  return Math.min(1, own.cols / drawn.cols, own.rows / drawn.rows);
}
