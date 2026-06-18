/**
 * Per-tile output recorder — an ANSI-stripped, size-capped ring of an agent's
 * terminal output, fed from the SAME pty data main already relays to the
 * renderer (so it's always on, with no dependency on a tile staying mounted).
 *
 * Phase 1 uses it only as the agent.read FALLBACK: when no Stop turn arrives
 * within the timeout (agent crashed, or a non-claude agent with no Stop hook),
 * return what it printed. Phase 2 builds agent.stream on top of it.
 */
const CAP = 256 * 1024; // per-tile ring cap

// Strip the common ANSI/VT escapes so buffered text is readable: CSI sequences,
// OSC strings, and lone control chars (keep \n and \t).
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const OTHER = /\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function stripAnsi(s: string): string {
  return s.replace(OSC, "").replace(CSI, "").replace(OTHER, "");
}

export class OutputRecorder {
  private buf = new Map<string, string>();
  /** Total bytes ever appended per tile — the epoch agent.read deltas against. */
  private total = new Map<string, number>();

  record(tileId: string, data: string): void {
    const clean = stripAnsi(data);
    if (!clean) return;
    const cur = (this.buf.get(tileId) ?? "") + clean;
    this.buf.set(tileId, cur.length > CAP ? cur.slice(cur.length - CAP) : cur);
    this.total.set(tileId, (this.total.get(tileId) ?? 0) + clean.length);
  }

  /** Append count since the start of recording — captured at send time. */
  mark(tileId: string): number {
    return this.total.get(tileId) ?? 0;
  }

  /** Text appended since `fromTotal`. Approximate if the ring dropped older
   *  bytes (returns at most the ring's worth). */
  since(tileId: string, fromTotal: number): string {
    const buf = this.buf.get(tileId) ?? "";
    const appended = (this.total.get(tileId) ?? 0) - fromTotal;
    if (appended <= 0) return "";
    return appended >= buf.length ? buf : buf.slice(buf.length - appended);
  }

  forget(tileId: string): void {
    this.buf.delete(tileId);
    this.total.delete(tileId);
  }
}
