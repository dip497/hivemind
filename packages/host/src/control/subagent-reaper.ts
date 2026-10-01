/**
 * Subagent-busy watchdog. The SubagentStart/SubagentStop hooks are NOT a
 * guaranteed matched pair: an edge is lost when a subagent errors, the turn is
 * interrupted (ESC → no Stop either), the session is compacted, or the process
 * dies. A lost SubagentStop leaves the per-tile in-flight set non-empty forever,
 * and since subagent-busy outranks the hook-driven turn state, the tile reads
 * "working" permanently even after it's plainly idle.
 *
 * We can't drain the set on the main `Stop` hook — a `run_in_background` Agent
 * subagent legitimately keeps running (and fires its SubagentStop) AFTER Stop.
 * So instead: a grace timer that the caller (RE)ARMS on every subagent edge and
 * on turn-end. A genuinely-active background population keeps emitting edges →
 * keeps resetting the timer → never reaped. A stuck set emits nothing → after
 * the grace window with no activity, the timer fires `onReap`, which force-drains
 * the set (treating the remaining ids as lost edges). Self-healing, and it can't
 * prematurely clear an agent that's still reporting progress.
 *
 * Clock is injectable so the reap window is unit-testable without real timers.
 */
export interface ReaperClock {
  set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
}

const realClock: ReaperClock = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (t) => clearTimeout(t),
};

export class SubagentReaper {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly graceMs: number,
    private readonly onReap: (tileId: string) => void,
    private readonly clock: ReaperClock = realClock,
  ) {}

  /** (Re)arm the grace timer for a tile that still has in-flight subagents. Call
   *  on every subagent edge (while still busy) and on turn-end while busy — each
   *  call pushes the reap deadline out by the full grace window. */
  arm(tileId: string): void {
    this.cancel(tileId);
    const t = this.clock.set(() => {
      this.timers.delete(tileId);
      this.onReap(tileId);
    }, this.graceMs);
    this.timers.set(tileId, t);
  }

  /** Cancel a tile's pending reap (call when its set drains naturally, or on
   *  tile close). No-op if none armed. */
  cancel(tileId: string): void {
    const t = this.timers.get(tileId);
    if (t !== undefined) {
      this.clock.clear(t);
      this.timers.delete(tileId);
    }
  }

  /** Is a reap currently armed for this tile? (test/introspection aid.) */
  armed(tileId: string): boolean {
    return this.timers.has(tileId);
  }
}
