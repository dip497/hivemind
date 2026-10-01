/**
 * Per-tile turn tracking. A hook reports a finished turn; drivers blocked in agent.read wait
 * for the NEXT turn after the epoch captured at agent.send time. Deterministic — no
 * screen-scrape.
 */
export interface TurnRecord {
  /** Monotonic per-tile turn counter; the epoch agent.read compares against. */
  seq: number;
  /** The turn's reply, as the agent's plugin reported it (`agent.reply`); null when none did. */
  text?: string | null;
}

type Waiter = { afterSeq: number; resolve: (r: TurnRecord) => void; timer: NodeJS.Timeout };

export class TurnTracker {
  private state = new Map<string, TurnRecord>();
  private waiters = new Map<string, Waiter[]>();
  /** Tiles that called agent.report (`hive ctl report`) during their CURRENT turn. Part
   *  of the single-delivery ladder: a worker that authored its own summary this
   *  turn must not ALSO have its raw turn auto-forwarded. Cleared at turn-end. */
  private reportedThisTurn = new Set<string>();
  /** A reply reported ahead of the turn end it belongs to. */
  private pendingReply = new Map<string, string>();

  /** The agent's plugin reported this turn's reply; the next turn end carries it. */
  recordReply(tileId: string, text: string): void {
    this.pendingReply.set(tileId, text);
  }

  /** The worker pushed an explicit report this turn — suppress the auto-report of
   *  the same turn (the worker's summary is the better message). Keyed by pty id. */
  markReported(tileId: string): void {
    this.reportedThisTurn.add(tileId);
  }

  private get(tileId: string): TurnRecord {
    let r = this.state.get(tileId);
    if (!r) { r = { seq: 0, text: null }; this.state.set(tileId, r); }
    return r;
  }

  /** The reply of the tile's last finished turn. */
  lastReply(tileId: string): string | null {
    return this.state.get(tileId)?.text ?? null;
  }

  /** Current turn count for a tile — captured at send time as the read epoch. */
  currentSeq(tileId: string): number {
    return this.get(tileId).seq;
  }

  /** A hook reported a finished turn. Bumps seq, takes the reply reported for it, and
   *  wakes any waiter whose epoch is now satisfied.
   *
   *  Returns whether this reply was ALREADY DELIVERED by a more specific channel, so
   *  the caller suppresses the fallback auto-report (the single-delivery ladder:
   *  read > explicit agent.report > auto-report). True when EITHER a blocking reader
   *  (agent.read) took it OR the worker authored an explicit report this turn —
   *  in both cases an auto-report banner would be a duplicate that spawns a spurious
   *  extra turn on the parent. */
  recordTurn(tileId: string, text?: string | null): boolean {
    const r = this.get(tileId);
    r.seq += 1;
    r.text = text ?? this.pendingReply.get(tileId) ?? null;
    this.pendingReply.delete(tileId);
    const reported = this.reportedThisTurn.delete(tileId); // explicit report this turn
    const ws = this.waiters.get(tileId);
    let woke = false;
    if (ws && ws.length > 0) {
      const remaining: Waiter[] = [];
      for (const w of ws) {
        if (r.seq > w.afterSeq) {
          clearTimeout(w.timer);
          w.resolve({ ...r });
          woke = true;
        } else {
          remaining.push(w);
        }
      }
      this.waiters.set(tileId, remaining);
    }
    return woke || reported;
  }

  /** Resolve on the first turn after `afterSeq`, or `null` on timeout. */
  waitForTurn(tileId: string, afterSeq: number, timeoutMs: number): Promise<TurnRecord | null> {
    const r = this.get(tileId);
    if (r.seq > afterSeq) return Promise.resolve({ ...r });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ws = this.waiters.get(tileId);
        if (ws) this.waiters.set(tileId, ws.filter((w) => w.resolve !== resolve));
        resolve(null);
      }, timeoutMs);
      const ws = this.waiters.get(tileId) ?? [];
      ws.push({ afterSeq, resolve, timer });
      this.waiters.set(tileId, ws);
    });
  }

  /** Drop a tile's state (on close). */
  forget(tileId: string): void {
    this.state.delete(tileId);
    this.reportedThisTurn.delete(tileId); // else a report-then-close-without-turn leaks
    this.pendingReply.delete(tileId);
    const ws = this.waiters.get(tileId);
    if (ws) for (const w of ws) { clearTimeout(w.timer); w.resolve({ seq: -1, text: null }); }
    this.waiters.delete(tileId);
  }
}
