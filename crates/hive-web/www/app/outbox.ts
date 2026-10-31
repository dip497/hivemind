// What the person sent from this page and the computer has not taken yet: kept here, words and
// photos, whichever screen shows, so that nothing is lost when it fails or the person looks away.
// One goes at a time, per agent, in the order sent: a short message never overtakes a long one with
// photos.

import type { Picked } from "./dom.js";
import type { Agent, Sent } from "./types.js";

/** With nothing moving on the link for this long, a message is told as not sent. */
const STALL_MS = 45_000;

/** Where a message stands. `part`: how much of it has gone, of 1. */
export type Stage =
  | { at: "going"; part: number }
  | { at: "sent" }
  | { at: "held" }
  | { at: "failed"; why: string };

export interface Outgoing {
  agent: Agent;
  text: string;
  photos: Picked[];
  /** When the person sent it. */
  at: number;
  stage: Stage;
  /** Told each time its stage changes; the screen showing it sets it. */
  shown?: (stage: Stage) => void;
}

/** How a message goes: what came of it; `going` is told how much has gone, as it goes. */
export type Sender = (agent: Agent, text: string, photos: Picked[], going: (part: number) => void) => Promise<Sent | false>;

export class Outbox {
  private readonly items = new Map<string, Outgoing[]>();
  /** The agents with a message on its way. */
  private readonly busy = new Set<string>();

  constructor(private readonly sender: Sender, private readonly notTaken: string) {}

  /** The messages still kept for the agent of `tile`, oldest first. */
  of(tile: string): Outgoing[] {
    return this.items.get(tile) ?? [];
  }

  /** Send `text` and `photos` to `agent`, after what it was sent before. */
  add(agent: Agent, text: string, photos: Picked[]): Outgoing {
    const item: Outgoing = { agent, text, photos, at: Date.now(), stage: { at: "going", part: 0 } };
    this.items.set(agent.tile, [...this.of(agent.tile), item]);
    void this.next(agent.tile);
    return item;
  }

  /** Try `item` again, after what is waiting to go. */
  again(item: Outgoing): void {
    this.tell(item, { at: "going", part: 0 });
    void this.next(item.agent.tile);
  }

  /** `item` needs keeping no more: the session file has it, or it went back to the box. */
  forget(item: Outgoing): void {
    const left = this.of(item.agent.tile).filter((x) => x !== item);
    if (left.length) this.items.set(item.agent.tile, left);
    else this.items.delete(item.agent.tile);
  }

  private tell(item: Outgoing, stage: Stage): void {
    item.stage = stage;
    item.shown?.(stage);
  }

  /** Each message of `tile` not yet tried, in turn; a second call while one goes does nothing. */
  private async next(tile: string): Promise<void> {
    if (this.busy.has(tile)) return;
    this.busy.add(tile);
    try {
      for (;;) {
        const item = this.of(tile).find((x) => x.stage.at === "going");
        if (!item) return;
        await this.go(item);
      }
    } finally {
      this.busy.delete(tile);
    }
  }

  /** Send `item`, until it is taken, refused or nothing moves. An answer after that still counts:
   *  a slow link may have carried it after all. */
  private async go(item: Outgoing): Promise<void> {
    let stalled: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    await new Promise<void>((settled) => {
      const stall = () => {
        clearTimeout(stalled);
        stalled = setTimeout(() => {
          timedOut = true;
          this.tell(item, { at: "failed", why: "The link stopped moving, so it may not have gone." });
          settled();
        }, STALL_MS);
      };
      stall();
      let part = 0;
      this.sender(item.agent, item.text, item.photos, (now) => {
        if (timedOut || now <= part) return;
        part = now;
        stall();
        this.tell(item, { at: "going", part });
      }).then((sent) => {
        // Failed since and tried again: that try says what became of it.
        if (timedOut && item.stage.at !== "failed") return;
        if (!sent) this.tell(item, { at: "failed", why: this.notTaken });
        else this.tell(item, { at: sent.held ? "held" : "sent" });
      }, (e: unknown) => {
        if (timedOut) return;
        this.tell(item, { at: "failed", why: e instanceof Error ? e.message : String(e) });
      }).finally(() => {
        clearTimeout(stalled);
        settled();
      });
    });
  }
}
