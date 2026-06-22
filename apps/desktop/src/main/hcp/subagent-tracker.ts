/**
 * Per-tile subagent tracking. The injected SubagentStart/SubagentStop hooks
 * report when a tile dispatches a Task subagent and when it finishes. A tile is
 * "subagent-busy" while it has ≥1 in-flight subagent — which the renderer's
 * status bus uses to keep the tile reading "working" even when its main loop is
 * back at the idle prompt (the background-agent case the screen-scrape misses).
 *
 * Tracking is a per-tile Set of agent ids (not a counter): a missed or duplicate
 * edge can't drift the busy state negative or stick it positive — re-adding an id
 * is idempotent, and a stop for an unknown id is a no-op. start()/stop() return
 * whether the tile's busy state CHANGED, so the caller only pushes to the
 * renderer on real edges (empty ↔ non-empty).
 */
export class SubagentTracker {
  private agents = new Map<string, Set<string>>();

  private set(tileId: string): Set<string> {
    let s = this.agents.get(tileId);
    if (!s) { s = new Set(); this.agents.set(tileId, s); }
    return s;
  }

  /** A subagent started. Returns true if the tile transitioned idle → busy. */
  start(tileId: string, agentId: string): boolean {
    const s = this.set(tileId);
    const was = s.size > 0;
    // Empty agentId (hook couldn't read one) still toggles busy via a sentinel,
    // so the tile isn't stuck idle; a matching empty-id stop clears it.
    s.add(agentId || "_");
    return !was && s.size > 0;
  }

  /** A subagent finished. Returns true if the tile transitioned busy → idle. */
  stop(tileId: string, agentId: string): boolean {
    const s = this.agents.get(tileId);
    if (!s || s.size === 0) return false;
    const was = s.size > 0;
    s.delete(agentId || "_");
    return was && s.size === 0;
  }

  busy(tileId: string): boolean {
    const s = this.agents.get(tileId);
    return !!s && s.size > 0;
  }

  /** Drop a tile's state (on close). Returns true if it had been busy. */
  forget(tileId: string): boolean {
    const s = this.agents.get(tileId);
    const was = !!s && s.size > 0;
    this.agents.delete(tileId);
    return was;
  }
}
