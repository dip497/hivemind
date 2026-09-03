/**
 * PtyOutputBuffer — coalesces a tile's pty output before it crosses to the
 * renderer.
 *
 * node-pty hands main one chunk per kernel read, and a streaming TUI (claude's
 * spinner + token stream, a codex redraw) produces hundreds of small writes a
 * second. Relaying each one as its own `webContents.send` costs a structured-
 * clone + an IPC message + a renderer task per chunk — the per-MESSAGE overhead,
 * not the bytes, is what saturates both event loops once the machine is busy,
 * and it's what turned into input lag and dropped canvas frames under load.
 *
 * VS Code's terminal does the same thing (TerminalDataBufferer): hold each
 * tile's output for a few milliseconds and ship one message. The delay is well
 * under a display frame, so latency is invisible; the message count drops by an
 * order of magnitude during bursts.
 *
 * Two extra rules keep it bounded:
 *   - a tile's pending buffer past `maxBytes` flushes immediately (a starved
 *     timer can't grow memory without limit, and huge messages don't build up);
 *   - when the window is hidden/minimized the flush interval stretches — the
 *     renderer can't paint anyway (backgroundThrottling is off, so it would
 *     otherwise keep parsing every chunk at full rate while you're not looking).
 */
export interface PtyOutputBufferOptions {
  /** Flush delay while the window is visible. */
  delayMs?: number;
  /** Flush delay while the window is hidden (see `hidden`). */
  hiddenDelayMs?: number;
  /** Per-tile pending cap — flushes at once when exceeded. */
  maxBytes?: number;
  /** Live probe: is the target window hidden/minimized right now? */
  hidden?: () => boolean;
  /** Timer hooks, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class PtyOutputBuffer {
  private pending = new Map<string, string>();
  private timer: unknown = null;
  private readonly delayMs: number;
  private readonly hiddenDelayMs: number;
  private readonly maxBytes: number;
  private readonly hidden: () => boolean;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly send: (tileId: string, data: string) => void,
    opts: PtyOutputBufferOptions = {},
  ) {
    this.delayMs = opts.delayMs ?? 8;
    this.hiddenDelayMs = opts.hiddenDelayMs ?? 200;
    this.maxBytes = opts.maxBytes ?? 256 * 1024;
    this.hidden = opts.hidden ?? (() => false);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Queue a chunk. Ships immediately only when the tile's pending output
   *  crosses the size cap; otherwise the next timer tick sends it. */
  push(tileId: string, data: string): void {
    if (!data) return;
    const cur = this.pending.get(tileId);
    const next = cur ? cur + data : data;
    if (next.length >= this.maxBytes) {
      this.pending.delete(tileId);
      this.send(tileId, next);
      return;
    }
    this.pending.set(tileId, next);
    if (this.timer === null) {
      const ms = this.hidden() ? this.hiddenDelayMs : this.delayMs;
      this.timer = this.setTimer(() => this.flushAll(), ms);
    }
  }

  /** Ship ONE tile's pending output now — call before relaying its exit so the
   *  final bytes land ahead of the "exited" banner. */
  flush(tileId: string): void {
    const data = this.pending.get(tileId);
    if (data === undefined) return;
    this.pending.delete(tileId);
    this.send(tileId, data);
    if (this.pending.size === 0) this.cancelTimer();
  }

  /** Ship everything pending. */
  flushAll(): void {
    this.cancelTimer();
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    for (const [tileId, data] of batch) this.send(tileId, data);
  }

  /** Drop a tile's pending output without sending (renderer gone). */
  forget(tileId: string): void {
    this.pending.delete(tileId);
    if (this.pending.size === 0) this.cancelTimer();
  }

  /** Bytes currently held for a tile (tests / diagnostics). */
  pendingBytes(tileId: string): number {
    return this.pending.get(tileId)?.length ?? 0;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
