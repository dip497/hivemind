/**
 * Turn-aware delivery for agent-to-agent messages.
 *
 * THE BUG THIS EXISTS FOR: a message to an agent (an agent.send, the line saying its
 * inbox has mail) is DELIVERED BY TYPING INTO ITS TUI — text, then
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
 *    never drain. A tile is serialized when its agent's file says it reports its turns, or
 *    once we've SEEN it emit a turn signal (`managed`); until then, delivery is immediate.
 *
 * A PERSON'S DRAFT is the third thing typing can break: a message typed into a composer
 * the person is writing in is merged with their words and submitted as theirs. So a
 * message is also held while the person has words at the prompt. An agent whose file says
 * how its empty prompt reads is asked its screen just before each message is typed; for
 * any other, the keys the person typed are the guess.
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

/** How long after a message's Enter its turn has to begin, else the Enter is pressed again, at
 *  most this many times: an agent still attaching a pasted photo drops the Enter. */
const ENTER_CHECK_MS = 600;
const ENTER_TRIES = 4;

/** After the person's last key, how long before a held message looks at the prompt again. */
const TYPING_SETTLE_MS = 1000;

/** How long a woken agent that never says it is up, nor settles, is waited for. */
const WAKE_WAIT_MS = 60_000;

/** A person who typed this recently may be writing a message of their own to the working
 *  agent: nothing is typed over it. */
const TYPING_QUIET_MS = 5000;

/** The keys that leave the composer empty: Enter, Ctrl-C, Ctrl-U. */
const CLEARS_DRAFT = new Set(["\r", "\x03", "\x15"]);

/** Keys the person typed that are words of a message, not a terminal's report or a lone control key. */
function isDraft(data: string): boolean {
  return data[0] !== "\x1b" && /[^\x00-\x1f\x7f]/.test(data);
}

/** A held message + an optional "it actually reached the agent" callback. The callback
 *  lets an approval start its answer-timeout from DELIVERY rather than from arrival — a
 *  request held 8 minutes for a busy parent must not then time out in 1. */
interface Held {
  text: string;
  /** Photo paths pasted, each alone, before the text. */
  pasted?: string[];
  onSent?: () => void;
  /** Asked just before it is typed: false drops it. */
  wanted?: () => boolean;
}

export interface Delivery {
  /** Asked just before it is typed: false drops it. */
  wanted?: () => boolean;
  /** Only ever at its prompt: never typed into a turn, even for an agent that reads mid-turn. */
  atPrompt?: boolean;
  /** Paths pasted, each alone, before the text: how an agent that attaches a photo so is given one. */
  pasted?: string[];
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
  /** Tiles the person typed into since their agent's turn last began: only their words at its
   *  prompt hold a message, never what the agent itself shows there. */
  private typedSinceTurn = new Set<string>();
  /** A pending release timer, so a burst of idle signals releases exactly one. */
  private releaseTimer = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tiles whose session sleeps: nothing is typed into them, and what comes waits. */
  private asleep = new Set<string>();
  /** Tiles woken whose agent has not yet said its session is up. */
  private waking = new Set<string>();
  /** Tiles whose screen is being read before a release, and whether another release was asked
   *  for meanwhile. */
  private reading = new Map<string, boolean>();
  /** Tiles whose last message's Enter is still to come, and the messages typed after it. */
  private submitting = new Map<string, string[][]>();
  /** Tiles whose message's Enter was pressed and whose turn has not been seen to begin. */
  private entered = new Set<string>();

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
    /** Whether the tile's agent reports its turns (its file says `turnSignal`): held for its
     *  prompt from the start, not only once a turn of it has been seen. */
    private readonly signalsTurns: (ptyId: string) => boolean = () => false,
    /** Whether the tile's prompt is empty, read from its screen; undefined when its agent does not
     *  say how its empty prompt reads, or the screen cannot be read. */
    private readonly promptEmpty: (ptyId: string) => Promise<boolean | undefined> = async () => undefined,
  ) {}

  /** What comes for this tile is held for its prompt, not typed at once. */
  private waitsForPrompt(ptyId: string): boolean {
    return this.managed.has(ptyId) || this.signalsTurns(ptyId);
  }

  /** Turn started (UserPromptSubmit / agent_start) — hold everything from here, and
   *  mark this tile as one that emits turn events (so it's serialized, not immediate). */
  setBusy(ptyId: string): void {
    this.waking.delete(ptyId);
    this.managed.add(ptyId);
    this.busy.add(ptyId);
    this.draft.delete(ptyId); // a turn began: whatever was in the composer was sent
    this.typedSinceTurn.delete(ptyId);
    this.entered.delete(ptyId);
    // A release waiting on the person's Enter would outlast this turn's end.
    const t = this.releaseTimer.get(ptyId);
    if (t) clearTimeout(t);
    this.releaseTimer.delete(ptyId);
  }

  /**
   * The person typed `data` into the tile. Printable text at the prompt is a draft, held
   * around until they send or clear it. Keys typed mid-turn answer the agent's own
   * prompts (a permission's "1"), and escape sequences are the terminal's reports.
   * A draft backspaced to nothing is seen only on the screen: once the person stops typing,
   * what waits looks at the prompt again.
   * `answers`: the keys answer the agent's own prompt (`agent.answer`), never a draft.
   */
  typed(ptyId: string, data: string, paste = false, answers = false): void {
    this.typedAt.set(ptyId, Date.now());
    this.entered.delete(ptyId);
    if (answers) return;
    if (data[0] !== "\x1b") this.typedSinceTurn.add(ptyId);
    // A line and the key that sends it can come in one write (a pasted line, a phone's): only
    // what follows the last such key is still being written.
    const cleared = paste ? -1 : Math.max(...[...CLEARS_DRAFT].map((key) => data.lastIndexOf(key)));
    if (cleared >= 0) {
      const sent = this.draft.delete(ptyId) || isDraft(data.slice(0, cleared));
      if (sent) this.scheduleRelease(ptyId, SUBMIT_SETTLE_MS);
      data = data.slice(cleared + 1);
      if (!data) return;
    }
    if (this.busy.has(ptyId)) return;
    if (paste || isDraft(data)) this.draft.add(ptyId);
    if (data[0] !== "\x1b" && this.queued.get(ptyId)?.length) {
      this.cancelRelease(ptyId);
      this.scheduleRelease(ptyId, TYPING_SETTLE_MS);
    }
  }

  /** Turn ended (Stop / agent_end). Coalesced: repeated calls before the release fires
   *  (pi sends two per turn) schedule at most one release. */
  setIdle(ptyId: string): void {
    this.waking.delete(ptyId);
    this.busy.delete(ptyId);
    this.scheduleRelease(ptyId);
  }

  /** The tile's session was put to sleep: its turn is over, and what comes for it waits. */
  sleep(ptyId: string): void {
    this.asleep.add(ptyId);
    this.busy.delete(ptyId);
    this.draft.delete(ptyId);
    this.cancelRelease(ptyId);
  }

  /** Woken, it comes back at its prompt: what waited goes once its agent says its session is up
   *  (`started`) or its screen has settled (`ready`), whichever is first, or after WAKE_WAIT_MS. */
  woke(ptyId: string): void {
    this.asleep.delete(ptyId);
    this.waking.add(ptyId);
    setTimeout(() => this.up(ptyId, IDLE_SETTLE_MS), WAKE_WAIT_MS).unref?.();
  }

  /** A woken agent's screen has settled: it is at its prompt. */
  ready(ptyId: string): void {
    this.up(ptyId, IDLE_SETTLE_MS);
  }

  /** The tile's agent says its session is up (it also says so mid-turn, after compacting). */
  started(ptyId: string): void {
    this.up(ptyId, SUBMIT_SETTLE_MS);
  }

  private up(ptyId: string, after: number): void {
    if (this.waking.delete(ptyId)) this.scheduleRelease(ptyId, after);
  }

  /**
   * Deliver `text` into a tile, typed + Enter. For a MANAGED tile (one that emits turn
   * events) it's queued and released one-per-turn when the tile is at its prompt. For a
   * tile we've never heard a turn from (hookless — codex/opencode) it's sent immediately.
   * Returns false only when an immediate send fails (dead + unmanaged tile); a queued
   * message returns true, because it will be delivered.
   */
  deliver(ptyId: string, text: string, onSent?: () => void, o: Delivery = {}): boolean {
    // An agent that steers reads it mid-turn: typed now, into the turn that is running.
    // Not while the person may have words at its prompt: typed this turn, or lately.
    const steer = !o.atPrompt && this.busy.has(ptyId) && !this.queued.get(ptyId)?.length && this.steers(ptyId)
      && !this.typedSinceTurn.has(ptyId) && Date.now() - (this.typedAt.get(ptyId) ?? 0) >= TYPING_QUIET_MS;
    const held = this.asleep.has(ptyId) || this.waking.has(ptyId);
    if (!held && (steer || (!this.waitsForPrompt(ptyId) && !this.draft.has(ptyId)))) {
      // Hookless (or not known to report its turns) → immediate, matching the pre-mailbox path.
      if (o.wanted && !o.wanted()) return true;
      const ok = this.send(ptyId, text, o.pasted);
      if (ok) onSent?.();
      return ok;
    }
    const q = this.queued.get(ptyId) ?? [];
    if (q.length >= MAX_QUEUED) q.shift(); // drop the stalest, keep the newest
    q.push({ text, ...(o.pasted ? { pasted: o.pasted } : {}), ...(onSent ? { onSent } : {}), ...(o.wanted ? { wanted: o.wanted } : {}) });
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
    this.typedSinceTurn.delete(ptyId);
    this.queued.delete(ptyId);
    this.asleep.delete(ptyId);
    this.waking.delete(ptyId);
    this.reading.delete(ptyId);
    this.submitting.delete(ptyId);
    this.entered.delete(ptyId);
    this.cancelRelease(ptyId);
  }

  private cancelRelease(ptyId: string): void {
    const t = this.releaseTimer.get(ptyId);
    if (t) clearTimeout(t);
    this.releaseTimer.delete(ptyId);
  }

  /** Schedule the release of ONE queued message. Idempotent while a release is pending
   *  (coalesces duplicate idle signals) and a no-op while the tile is busy or empty. */
  private scheduleRelease(ptyId: string, after = IDLE_SETTLE_MS): void {
    if (this.releaseTimer.has(ptyId)) return; // a release is already pending
    if (this.reading.has(ptyId)) { this.reading.set(ptyId, true); return; } // asked again once its screen is read
    if (this.busy.has(ptyId)) return; // still mid-turn
    if (this.asleep.has(ptyId) || this.waking.has(ptyId)) return; // nothing runs to read it yet
    if (!this.queued.get(ptyId)?.length) return; // nothing to send
    const t = setTimeout(() => {
      this.releaseTimer.delete(ptyId);
      void this.release(ptyId);
    }, after);
    t.unref?.();
    this.releaseTimer.set(ptyId, t);
  }

  /** Type ONE queued message, if the tile is at its prompt and the person has no words there. */
  private async release(ptyId: string): Promise<void> {
    if (this.busy.has(ptyId) || !this.queued.get(ptyId)?.length) return; // raced back to busy / drained
    // The prompt is read just before typing: a draft deleted key by key is gone, and words typed
    // while the agent worked are there, though no key said so.
    this.reading.set(ptyId, false);
    const empty = await this.promptEmpty(ptyId).catch(() => undefined);
    const again = this.reading.get(ptyId);
    if (!this.reading.delete(ptyId)) return; // forgotten meanwhile
    if (empty) this.draft.delete(ptyId);
    else if (empty === false && this.typedSinceTurn.has(ptyId)) this.draft.add(ptyId);
    const q = this.queued.get(ptyId);
    if (this.busy.has(ptyId) || this.asleep.has(ptyId) || this.waking.has(ptyId) || !q?.length) return;
    if (this.draft.has(ptyId)) {
      // The person is writing there: it waits for their Enter, or for a key that may have emptied it.
      if (again) this.scheduleRelease(ptyId, TYPING_SETTLE_MS);
      return;
    }
    let next: Held | undefined;
    do next = q.shift(); while (next?.wanted && !next.wanted());
    if (!q.length) this.queued.delete(ptyId);
    this.onHeld(ptyId, q.length);
    if (!next) return;
    // A hookless tile reports no turn end to wait for: the rest follow at once.
    if (!this.waitsForPrompt(ptyId)) {
      if (this.send(ptyId, next.text, next.pasted)) next.onSent?.();
      this.scheduleRelease(ptyId);
      return;
    }
    // Optimistic: this delivery starts a turn, so hold the rest until it ends. A
    // managed agent always turns on a submitted prompt (claude/pi/droid), so the
    // matching setIdle WILL arrive and drain the next. If the send fails (dead pty),
    // un-hold so the queue doesn't wedge — forget() on exit is the real backstop.
    // ponytail: relies on "submitted prompt ⇒ a turn"; true for every managed agent.
    this.busy.add(ptyId);
    if (this.send(ptyId, next.text, next.pasted)) next.onSent?.();
    else {
      this.busy.delete(ptyId);
      this.scheduleRelease(ptyId);
    }
  }

  private send(ptyId: string, text: string, pasted: string[] = []): boolean {
    // The message is a paste (a newline in it must not submit half of it); the Enter that
    // follows is the keystroke that sends it. A path pasted alone is one paste of its own, and the
    // words after it are set apart by a space, whether it was attached or stayed a path.
    const pastes = [...pasted, ...(text ? [pasted.length ? ` ${text}` : text] : [])];
    if (!pastes.length) return false;
    // Typed before the last message's Enter, it would be glued to that message: it waits for it.
    const waiting = this.submitting.get(ptyId);
    if (waiting) {
      waiting.push(pastes);
      return true;
    }
    return this.type(ptyId, pastes);
  }

  /** Type one message, then, `submitDelayMs` later, the Enter that sends it, then the next
   *  waiting for that Enter. */
  private type(ptyId: string, pastes: string[]): boolean {
    for (const p of pastes) if (!this.write(ptyId, p, true)) return false;
    this.submitting.set(ptyId, []);
    const t = setTimeout(() => {
      this.write(ptyId, "\r");
      this.checkEntered(ptyId, ENTER_TRIES);
      const waiting = this.submitting.get(ptyId) ?? [];
      this.submitting.delete(ptyId);
      let next: string[] | undefined;
      while ((next = waiting.shift()) && !this.type(ptyId, next)) { /* its pty is gone: so is the rest's */ }
      if (next) this.submitting.get(ptyId)!.push(...waiting);
    }, this.submitDelayMs);
    t.unref?.();
    return true;
  }

  /** The Enter of the message last typed sent it, as its turn beginning says; while its words
   *  still wait at the prompt instead, it is pressed again. */
  private checkEntered(ptyId: string, tries: number): void {
    if (!this.signalsTurns(ptyId)) return;
    this.entered.add(ptyId);
    const t = setTimeout(async () => {
      if (!this.entered.has(ptyId) || this.submitting.has(ptyId)) return;
      const empty = await this.promptEmpty(ptyId);
      if (!this.entered.has(ptyId) || this.submitting.has(ptyId)) return;
      if (empty !== false || tries <= 1) {
        this.entered.delete(ptyId);
        return;
      }
      this.write(ptyId, "\r");
      this.checkEntered(ptyId, tries - 1);
    }, ENTER_CHECK_MS);
    t.unref?.();
  }
}
