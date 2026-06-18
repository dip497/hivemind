/**
 * Pipes — wire one agent's finished-turn reply into another agent's input, so
 * an orchestrator can chain workers ("B's output feeds A"). A directed graph of
 * src → {dst}. Forwarding itself happens in main's turn handler (it has the
 * transcript + pty write); this just owns the edges.
 *
 * Self-loops AND cycles are refused at connect time — without that, an A→B→A
 * (or longer) ring is a forwarding pump that ping-pongs the agents' replies
 * forever once turn-forwarding is live.
 */
export class PipeManager {
  private pipes = new Map<string, Set<string>>();

  /** Can `from` already reach `target` by following existing edges? */
  private reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of this.pipes.get(n) ?? []) stack.push(d);
    }
    return false;
  }

  /** Pipe src → dst. Returns false for a self-loop OR a connection that would
   *  close a cycle (dst can already reach src). */
  connect(src: string, dst: string): boolean {
    if (!src || !dst || src === dst) return false;
    if (this.reaches(dst, src)) return false; // src→dst would complete a cycle
    const set = this.pipes.get(src) ?? new Set<string>();
    set.add(dst);
    this.pipes.set(src, set);
    return true;
  }

  /** Remove one edge, or all of src's edges when dst is omitted. */
  disconnect(src: string, dst?: string): void {
    if (!dst) { this.pipes.delete(src); return; }
    const set = this.pipes.get(src);
    if (!set) return;
    set.delete(dst);
    if (set.size === 0) this.pipes.delete(src);
  }

  /** Current destinations for src. */
  dests(src: string): string[] {
    return [...(this.pipes.get(src) ?? [])];
  }

  /** Drop a tile from the graph entirely (on close). */
  forget(tileId: string): void {
    this.pipes.delete(tileId);
    for (const set of this.pipes.values()) set.delete(tileId);
  }
}
