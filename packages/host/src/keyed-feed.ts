/**
 * Rows by key, numbered as they change: what a follower that reconnects catches up on. Given the
 * rows now, the feed tells which changed or went, each one position on; it keeps the last of those
 * for `since`, up to `keep` of them and `bytes` of their JSON, and a follower behind that is
 * answered null: take the rows whole again.
 */
import type { KeyedChange, KeyedSnapshot } from "@hivemind/workspace-api/home";

export class KeyedFeed<T> {
  private rows = new Map<string, { row: T; json: string }>();
  private seq = 0;
  private told: Array<{ change: KeyedChange<T>; bytes: number }> = [];
  private bytesTold = 0;

  constructor(private readonly o: { keep?: number; bytes?: number } = {}) {}

  /** The rows are `next` now: what changed, each numbered on. */
  set(next: ReadonlyMap<string, T>): KeyedChange<T>[] {
    const out: KeyedChange<T>[] = [];
    for (const [key, row] of next) {
      const json = JSON.stringify(row);
      if (this.rows.get(key)?.json === json) continue;
      this.rows.set(key, { row, json });
      out.push(this.tell({ seq: ++this.seq, key, row }, json.length));
    }
    for (const key of [...this.rows.keys()]) {
      if (next.has(key)) continue;
      this.rows.delete(key);
      out.push(this.tell({ seq: ++this.seq, key, gone: true }, key.length));
    }
    return out;
  }

  snapshot(): KeyedSnapshot<T> {
    return { seq: this.seq, rows: [...this.rows].map(([key, { row }]) => [key, row]) };
  }

  /** What changed after `seq`; null when that is more than the feed keeps, or a position it never
   *  gave. */
  since(seq: number): { seq: number; changes: KeyedChange<T>[] } | null {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.seq) return null;
    const oldest = this.told[0]?.change.seq ?? this.seq + 1;
    if (seq + 1 < oldest) return null;
    return { seq: this.seq, changes: this.told.filter((t) => t.change.seq > seq).map((t) => t.change) };
  }

  private tell(change: KeyedChange<T>, bytes: number): KeyedChange<T> {
    this.told.push({ change, bytes });
    this.bytesTold += bytes;
    const keep = this.o.keep ?? 2000;
    const most = this.o.bytes ?? 256 * 1024;
    while (this.told.length > keep || (this.bytesTold > most && this.told.length > 1)) this.bytesTold -= this.told.shift()!.bytes;
    return change;
  }
}
