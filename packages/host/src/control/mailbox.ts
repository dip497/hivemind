/**
 * Turn-aware delivery for agent-to-agent messages.
 *
 * THE BUG THIS EXISTS FOR: every HCP message to an agent (a worker's report, an
 * approval request, an agent.send) is DELIVERED BY TYPING INTO ITS TUI — text, then
 * Enter. That only works if the agent is sitting at its prompt. Fire it while the
 * agent is mid-turn (running a tool, streaming a reply) and the text lands in the
 * composer unsubmitted: the Enter is swallowed, the message is never read, and
 * whoever was waiting on the answer — a supervised worker blocked on approval —
 * waits until it times out. Silently. On screen it looks like the agent ignored you.
 *
 * So: hold the message until the tile is at its prompt, then type it — ONE per turn
 * (delivering a message starts the agent's next turn, so the rest wait for the turn
 * after that).
 *
 * Busy/idle is deterministic, not scraped — `setBusy` from the UserPromptSubmit /
 * agent_start hook, `setIdle` from Stop / agent_end (see index.ts `onEvent`).
 *
 * TWO invariants this class has to survive, both of which broke a naive version:
 *  - DUPLICATE idle signals. pi's agent_end posts BOTH a `turn` and a `status:idle`
 *    event, so setIdle fires twice per turn. A "pop one per setIdle" design drained
 *    TWO messages per turn — the second typed into the now-busy TUI and lost. The
 *    release here is coalesced through a single settle timer, so N idle signals in a
 *    row release exactly one message.
 *  - HOOKLESS agents (codex, opencode) never emit turn events, so setBusy/setIdle
 *    never fire for them. They must keep delivering IMMEDIATELY, or their queue would
 *    never drain. A tile is only serialized once we've SEEN it emit a turn signal
 *    (`managed`); until then, delivery is immediate — exactly the old behavior.
 *
 * A PERSON'S DRAFT is the third thing typing can break: a message typed into a composer
 * the person is writing in is merged with their words and submitted as theirs. So a
 * message is also held while the person has typed there and not yet sent or cleared it.
 *
 * Keyed by PTY id (`hm:<bare>`), which is what the hooks report and what writeToTile
 * takes.
 */

/** Per-tile cap. A managed parent that never comes back to its prompt shouldn't grow
 *  an unbounded backlog; past this, the OLDEST queued message is dropped (the newest
 *  report is the one that still matters). */
const MAX_QUEUED = 32;

/** Let the TUI settle after turn-end before typing into it. The prompt is redrawn on
 *  Stop; typing into the same frame can land mid-repaint. Also the coalescing window:
 *  several idle signals for one turn collapse into a single release. */
const IDLE_SETTLE_MS = 250;

/** After the person's own Enter, how long the turn it starts has to be reported before a
 *  held message is typed: typed sooner, it lands in the turn that is starting. */
const SUBMIT_SETTLE_MS = 2000;

/** A person who typed this recently may be writing a message of their own to the working
 *  agent: nothing is typed over it. */
const TYPING_QUIET_MS = 5000;

/** The keys that leave the composer empty: Enter, Ctrl-C, Ctrl-U. */
const CLEARS_DRAFT = new Set(["\r", "\x03", "\x15"]);

/** A held message + an optional "it actually reached the agent" callback. The callback
 *  lets an approval start its answer-timeout from DELIVERY rather than from arrival — a
 *  request held 8 minutes for a busy parent must not then time out in 1. */
interface Held {
  text: string;
  onSent?: () => void;
}

export class Mailbox {
  /** A turn is in progress (or a release is in flight that will start one). */
  private busy = new Set<string>();
  /** Tiles we've ever seen emit a turn signal → serialize their delivery. Everything
   *  else (hookless agents) delivers immediately. */
  private managed = new Set<string>();
  private queued = new Map<string, Held[]>();
  /** Tiles whose composer holds something the person typed and has not sent. */
  private draft = new Set<string>();
  /** When the person last typed into each tile. */
  private typedAt = new Map<string, number>();
  /** A pending release timer, so a burst of idle signals releases exactly one. */
  private releaseTimer = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    /** Raw write into a tile's pty. `paste` = a message handed over as one block, not
     *  keystrokes. False → dead/unknown tile. */
    private readonly write: (ptyId: string, data: string, paste?: boolean) => boolean,
    /** Gap between the text and the Enter — claude's TUI drops a bundled newline. */
    private readonly submitDelayMs: number,
    /** Whether the tile's agent reads a message typed while it works (its file says `steer`). */
    private readonly steers: (ptyId: string) => boolean = () => false,
    /** How many messages a tile has waiting changed. */
    private readonly onHeld: (ptyId: string, held: number) => void = () => {},
  ) {}

  /** Turn started (UserPromptSubmit / agent_start) — hold everything from here, and
   *  mark this tile as one that emits turn events (so it's serialized, not immediate). */
  setBusy(ptyId: string): void {
    this.managed.add(ptyId);
    this.busy.add(ptyId);
    this.draft.delete(ptyId); // a turn began: whatever was in the composer was sent
    // A release waiting on the person's Enter would outlast this turn's end.
    const t = this.releaseTimer.get(ptyId);
    if (t) clearTimeout(t);
    this.releaseTimer.delete(ptyId);
  }

  /**
   * The person typed `data` into the tile. Printable text at the prompt is a draft, held
   * around until they send or clear it. Keys typed mid-turn answer the agent's own
   * prompts (a permission's "1"), and escape sequences are the terminal's reports.
   * ponytail: a draft backspaced to nothing still counts, until Enter, Ctrl-C or Ctrl-U.
   */
  typed(ptyId: string, data: string, paste = false): void {
    this.typedAt.set(ptyId, Date.now());
    if (!paste && CLEARS_DRAFT.has(data)) {
      if (this.draft.delete(ptyId)) this.scheduleRelease(ptyId, SUBMIT_SETTLE_MS);
      return;
    }
    if (this.busy.has(ptyId)) return;
    if (paste || (data[0] !== "\x1b" && /[^\x00-\x1f\x7f]/.test(data))) this.draft.add(ptyId);
  }

  /** Turn ended (Stop / agent_end). Coalesced: repeated calls before the release fires
   *  (pi sends two per turn) schedule at most one release. */
  setIdle(ptyId: string): void {
    this.busy.delete(ptyId);
    this.scheduleRelease(ptyId);
  }

  /**
   * Deliver `text` into a tile, typed + Enter. For a MANAGED tile (one that emits turn
   * events) it's queued and released one-per-turn when the tile is at its prompt. For a
   * tile we've never heard a turn from (hookless — codex/opencode) it's sent immediately.
   * Returns false only when an immediate send fails (dead + unmanaged tile); a queued
   * message returns true, because it will be delivered.
   */
  deliver(ptyId: string, text: string, onSent?: () => void): boolean {
    // An agent that steers reads it mid-turn: typed now, into the turn that is running.
    const steer = this.busy.has(ptyId) && !this.queued.get(ptyId)?.length && this.steers(ptyId)
      && Date.now() - (this.typedAt.get(ptyId) ?? 0) >= TYPING_QUIET_MS;
    if (steer || (!this.managed.has(ptyId) && !this.draft.has(ptyId))) {
      // Hookless (or not-yet-seen-a-turn) → immediate, matching the pre-mailbox path.
      const ok = this.send(ptyId, text);
      if (ok) onSent?.();
      return ok;
    }
    const q = this.queued.get(ptyId) ?? [];
    if (q.length >= MAX_QUEUED) q.shift(); // drop the stalest, keep the newest
    q.push({ text, onSent });
    this.queued.set(ptyId, q);
    this.onHeld(ptyId, q.length);
    if (!this.busy.has(ptyId)) this.scheduleRelease(ptyId);
    return true;
  }

  /** Whether anything is waiting for this tile to come back to its prompt. */
  pending(ptyId: string): number {
    return this.queued.get(ptyId)?.length ?? 0;
  }

  /** Tile closed / pty exited — drop its state so a recycled id starts clean. */
  forget(ptyId: string): void {
    this.busy.delete(ptyId);
    this.managed.delete(ptyId);
    this.draft.delete(ptyId);
    this.typedAt.delete(ptyId);
    this.queued.delete(ptyId);
    const t = this.releaseTimer.get(ptyId);
    if (t) clearTimeout(t);
    this.releaseTimer.delete(ptyId);
  }

  /** Schedule the release of ONE queued message. Idempotent while a release is pending
   *  (coalesces duplicate idle signals) and a no-op while the tile is busy or empty. */
  private scheduleRelease(ptyId: string, after = IDLE_SETTLE_MS): void {
    if (this.releaseTimer.has(ptyId)) return; // a release is already pending
    if (this.busy.has(ptyId)) return; // still mid-turn
    if (this.draft.has(ptyId)) return; // the person is writing there
    if (!this.queued.get(ptyId)?.length) return; // nothing to send
    const t = setTimeout(() => {
      this.releaseTimer.delete(ptyId);
      const q = this.queued.get(ptyId);
      if (this.busy.has(ptyId) || this.draft.has(ptyId) || !q?.length) return; // raced back to busy / drained
      const next = q.shift()!;
      if (!q.length) this.queued.delete(ptyId);
      this.onHeld(ptyId, q.length);
      // A hookless tile reports no turn end to wait for: the rest follow at once.
      if (!this.managed.has(ptyId)) {
        if (this.send(ptyId, next.text)) next.onSent?.();
        this.scheduleRelease(ptyId);
        return;
      }
      // Optimistic: this delivery starts a turn, so hold the rest until it ends. A
      // managed agent always turns on a submitted prompt (claude/pi/droid), so the
      // matching setIdle WILL arrive and drain the next. If the send fails (dead pty),
      // un-hold so the queue doesn't wedge — forget() on exit is the real backstop.
      // ponytail: relies on "submitted prompt ⇒ a turn"; true for every managed agent.
      this.busy.add(ptyId);
      if (this.send(ptyId, next.text)) next.onSent?.();
      else {
        this.busy.delete(ptyId);
        this.scheduleRelease(ptyId);
      }
    }, after);
    t.unref?.();
    this.releaseTimer.set(ptyId, t);
  }

  private send(ptyId: string, text: string): boolean {
    // The message is a paste (a newline in it must not submit half of it); the Enter that
    // follows is the keystroke that sends it.
    const ok = this.write(ptyId, text, true);
    if (!ok) return false;
    const t = setTimeout(() => this.write(ptyId, "\r"), this.submitDelayMs);
    t.unref?.();
    return true;
  }
}
