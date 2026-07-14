/**
 * Turn-aware delivery for agent-to-agent messages.
 *
 * THE BUG THIS EXISTS FOR: every HCP message to an agent (a worker's report, an
 * approval request, a hive_send) is DELIVERED BY TYPING INTO ITS TUI — text, then
 * Enter. That only works if the agent is sitting at its prompt. Fire it while the
 * agent is mid-turn (running a tool, streaming a reply) and the text lands in the
 * composer unsubmitted: the Enter is swallowed, the message is never read, and
 * whoever was waiting on the answer — a supervised worker blocked on approval —
 * waits until it times out. Silently. On screen it looks like the agent ignored you.
 *
 * So: hold the message until the tile is at its prompt, then type it.
 *
 * Busy/idle is deterministic, not scraped — `status`(working) from the
 * UserPromptSubmit hook and `turn` from Stop (see index.ts `onEvent`). A tile we
 * have never heard a turn-start from (codex, opencode — no hooks) is treated as
 * idle and delivered to immediately: same behavior as before, no regression.
 *
 * ONE message per idle window. Delivering a message starts the agent's next turn,
 * which makes it busy again — so the rest of the queue waits for the turn after
 * that. Keyed by PTY id (`hm:<bare>`), which is what the hooks report and what
 * writeToTile takes.
 */

/** Per-tile cap. A parent that never comes back to its prompt shouldn't grow an
 *  unbounded backlog; past this, the OLDEST queued message is dropped (the newest
 *  report is the one that still matters). */
const MAX_QUEUED = 32;

/** Let the TUI settle after turn-end before typing into it. The prompt is redrawn
 *  on Stop; typing into the same frame can land mid-repaint. */
const IDLE_SETTLE_MS = 250;

/** A held message + an optional "it actually reached the agent" callback. The
 *  callback is what lets an approval start its answer-timeout from DELIVERY rather
 *  than from arrival — a request that waited 8 minutes for a busy parent must not
 *  then time out in 1. */
interface Held {
  text: string;
  onSent?: () => void;
}

export class Mailbox {
  private busy = new Set<string>();
  private queued = new Map<string, Held[]>();

  constructor(
    /** Raw write into a tile's pty. False → dead/unknown tile. */
    private readonly write: (ptyId: string, data: string) => boolean,
    /** Gap between the text and the Enter — claude's TUI drops a bundled newline. */
    private readonly submitDelayMs: number,
  ) {}

  /** Turn started (UserPromptSubmit / agent_start) — hold everything from here. */
  setBusy(ptyId: string): void {
    this.busy.add(ptyId);
  }

  /** Turn ended (Stop / agent_end) — the tile is back at its prompt. Deliver ONE. */
  setIdle(ptyId: string): void {
    this.busy.delete(ptyId);
    const q = this.queued.get(ptyId);
    if (!q?.length) return;
    const next = q.shift()!;
    if (!q.length) this.queued.delete(ptyId);
    const t = setTimeout(() => {
      if (this.send(ptyId, next.text)) next.onSent?.();
    }, IDLE_SETTLE_MS);
    t.unref?.();
  }

  /**
   * Deliver `text` into a tile, typed + Enter. Sends now if the tile is at its
   * prompt; otherwise queues it until the current turn ends. Returns false only
   * when the tile is dead AND idle (i.e. the write itself failed) — a queued
   * message reports true, because it will be delivered.
   */
  deliver(ptyId: string, text: string, onSent?: () => void): boolean {
    if (!this.busy.has(ptyId)) {
      const ok = this.send(ptyId, text);
      if (ok) onSent?.();
      return ok;
    }
    const q = this.queued.get(ptyId) ?? [];
    if (q.length >= MAX_QUEUED) q.shift(); // drop the stalest, keep the newest
    q.push({ text, onSent });
    this.queued.set(ptyId, q);
    return true;
  }

  /** Whether anything is waiting for this tile to come back to its prompt. */
  pending(ptyId: string): number {
    return this.queued.get(ptyId)?.length ?? 0;
  }

  /** Tile closed / pty exited — drop its state so a recycled id starts clean. */
  forget(ptyId: string): void {
    this.busy.delete(ptyId);
    this.queued.delete(ptyId);
  }

  private send(ptyId: string, text: string): boolean {
    const ok = this.write(ptyId, text);
    if (!ok) return false;
    const t = setTimeout(() => this.write(ptyId, "\r"), this.submitDelayMs);
    t.unref?.();
    return true;
  }
}
