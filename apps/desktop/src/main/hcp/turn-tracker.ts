/**
 * Per-tile turn tracking. The injected Stop hook reports a finished turn (with
 * the transcript path); drivers blocked in agent.read wait for the NEXT turn
 * after the epoch captured at agent.send time. Deterministic — no screen-scrape.
 */
export interface TurnRecord {
  /** Monotonic per-tile turn counter; the epoch agent.read compares against. */
  seq: number;
  /** Transcript path from the most recent Stop (used to read the reply). */
  transcriptPath: string | null;
  /** Inline reply text carried by the turn event itself (pi has no transcript —
   *  its bridge extension sends the reply here). null for claude/droid, which
   *  carry a transcriptPath instead. */
  text?: string | null;
}

type Waiter = { afterSeq: number; resolve: (r: TurnRecord) => void; timer: NodeJS.Timeout };

export class TurnTracker {
  private state = new Map<string, TurnRecord>();
  private waiters = new Map<string, Waiter[]>();

  private get(tileId: string): TurnRecord {
    let r = this.state.get(tileId);
    if (!r) { r = { seq: 0, transcriptPath: null, text: null }; this.state.set(tileId, r); }
    return r;
  }

  /** Current turn count for a tile — captured at send time as the read epoch. */
  currentSeq(tileId: string): number {
    return this.get(tileId).seq;
  }

  /** A Stop hook reported a finished turn. Bumps seq, stores the transcript, and
   *  wakes any waiter whose epoch is now satisfied. */
  recordTurn(tileId: string, transcriptPath: string | null, text?: string | null): void {
    const r = this.get(tileId);
    r.seq += 1;
    r.transcriptPath = transcriptPath;
    r.text = text ?? null; // pi carries the inline reply here; claude/droid → null
    const ws = this.waiters.get(tileId);
    if (!ws || ws.length === 0) return;
    const remaining: Waiter[] = [];
    for (const w of ws) {
      if (r.seq > w.afterSeq) {
        clearTimeout(w.timer);
        w.resolve({ ...r });
      } else {
        remaining.push(w);
      }
    }
    this.waiters.set(tileId, remaining);
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
    const ws = this.waiters.get(tileId);
    if (ws) for (const w of ws) { clearTimeout(w.timer); w.resolve({ seq: -1, transcriptPath: null, text: null }); }
    this.waiters.delete(tileId);
  }
}
