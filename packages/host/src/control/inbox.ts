/**
 * What other agents have for an agent: their replies, reports, waits and approvals, kept in order
 * until it reads them (`hive ctl inbox`). Its terminal is only told that some came, never what
 * they say, so nothing another agent writes reaches it as if the person had typed it.
 *
 * Keyed by bare tile id.
 */
import type { InboxKind, InboxMessage } from "@hivemind/workspace-api/agents";

export type { InboxKind, InboxMessage } from "@hivemind/workspace-api/agents";

/** Past this many unread for one agent, the oldest go, and its next read says how many. */
const MAX_UNREAD = 500;

/** The text, or how to say it when read: null when it no longer holds (a wait that ended). */
type Said = string | (() => string | null);

interface Kept {
  message: Omit<InboxMessage, "text">;
  text: Said;
  /** It was read, by the agent it is for. */
  onRead?: () => void;
}

export interface Posted {
  from: string;
  name: string;
  kind: InboxKind;
  turn?: number;
  text: Said;
}

export interface Taken {
  messages: InboxMessage[];
  /** How many went unread because too many waited. */
  dropped: number;
}

export class Inbox {
  private kept = new Map<string, Kept[]>();
  private dropped = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  /** Agents told already that messages wait, until that is typed or nothing waits. */
  private ringing = new Set<string>();
  private lastId = 0;

  constructor(
    /** Tell `to`'s terminal that messages wait: false when it has none. `wanted` is asked again
     *  just before it is typed; `rung` when it was. */
    private readonly ring: (to: string, wanted: () => boolean, rung: () => void) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keep a message for `to`, and tell it some wait. False when it could not be told. */
  post(to: string, m: Posted, onRead?: () => void): boolean {
    const list = this.kept.get(to) ?? [];
    const { text, ...rest } = m;
    list.push({ message: { id: ++this.lastId, at: this.now(), ...rest }, text, ...(onRead ? { onRead } : {}) });
    if (list.length > MAX_UNREAD) {
      list.shift();
      this.dropped.set(to, (this.dropped.get(to) ?? 0) + 1);
    }
    this.kept.set(to, list);
    for (const wake of this.waiters.get(to) ?? []) wake();
    return this.tell(to);
  }

  /** Tell `to` again that messages wait, when some do and it was not told (it was asleep). */
  remind(to: string): void {
    if (this.unread(to) > 0) this.tell(to);
  }

  /** Tell `to` that messages wait, unless it was told already. False when it could not be told. */
  private tell(to: string): boolean {
    if (this.ringing.has(to)) return true;
    this.ringing.add(to);
    const wanted = (): boolean => {
      if (this.unread(to) > 0) return true;
      this.ringing.delete(to);
      return false;
    };
    const told = this.ring(to, wanted, () => this.ringing.delete(to));
    if (!told) this.ringing.delete(to);
    return told;
  }

  /** How many wait for `to`, as they would be read now. */
  unread(to: string): number {
    return (this.kept.get(to) ?? []).filter((k) => typeof k.text === "string" || k.text() !== null).length;
  }

  /** Everything waiting for `to`, oldest first; read now, so the next take starts after it. */
  take(to: string): Taken {
    const list = this.kept.get(to) ?? [];
    this.kept.delete(to);
    const dropped = this.dropped.get(to) ?? 0;
    this.dropped.delete(to);
    const messages: InboxMessage[] = [];
    for (const k of list) {
      const text = typeof k.text === "string" ? k.text : k.text();
      if (text === null) continue;
      messages.push({ ...k.message, text });
      k.onRead?.();
    }
    return { messages, dropped };
  }

  /** What waits for `to` now, else the first to come within `ms`. */
  async wait(to: string, ms: number): Promise<Taken> {
    if (ms > 0 && !this.unread(to)) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(to) ?? new Set();
        const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
        const timer = setTimeout(done, ms);
        timer.unref?.();
        set.add(done);
        this.waiters.set(to, set);
      });
    }
    return this.take(to);
  }

  /** A message of `from`'s was given to whoever asked for it (`hive ctl read`): no one is told it
   *  again. `turn`: only that turn's. */
  given(from: string, kind: InboxKind, turn?: number): void {
    for (const [to, list] of this.kept) {
      const left = list.filter((k) => !(k.message.from === from && k.message.kind === kind && (turn === undefined || k.message.turn === turn)));
      if (left.length) this.kept.set(to, left);
      else this.kept.delete(to);
    }
  }

  /** `tile` is gone: what waited for it goes, and whoever waits on its inbox is answered. */
  forget(tile: string): void {
    this.kept.delete(tile);
    this.dropped.delete(tile);
    this.ringing.delete(tile);
    for (const wake of this.waiters.get(tile) ?? []) wake();
    this.waiters.delete(tile);
  }
}
