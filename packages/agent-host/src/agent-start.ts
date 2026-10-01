/**
 * An agent's first seconds in a terminal, for whoever started its session: the window that opened
 * it, or a host that spawned it with no window. A startup screen its launch flags already answered
 * is skipped, and a first task it does not take on its command line is typed once its screen
 * settles. One set of rules, so a window and a host start an agent the same way.
 *
 * A startup screen is skipped only at the start of a session, only before the person has touched
 * the terminal, and only a couple of times: past that the screen is the agent's, not ours. The
 * manifest names such a screen and the key that skips it (never one that grants anything): an
 * agent that gates its own hooks behind a review opens it even when the launch flags say to run
 * them, which makes the answer decorative.
 *
 * A task goes in once the screen has been quiet for a couple of looks (boot output stopped: the
 * agent is at its prompt), or after enough of them that an agent that never goes quiet (a tip, a
 * clock or a spinner ticking in its composer) is not held for ever; never while the screen waits
 * on the person, since a task typed into a chooser picks an option instead.
 */
import type { AgentProviderDef } from "@hivemind/agents";
import { SPAWN_SUBMIT_RETRY_MS, SUBMIT_DELAY_MS } from "./agent-io.js";

/** How often the starter looks at the agent. */
export const START_TICK_MS = 1200;
/** Quiet looks after boot (~2.4 s) that mean a ready prompt. */
const SETTLE_TICKS = 2;
/** Looks after which a task goes in even with the screen still moving. */
const DEADLINE_TICKS = 8;
/** How long after the start a startup screen is still the starter's to skip. */
export const DISMISS_WINDOW_MS = 90_000;
/** How many startup screens a session's starter skips at most. */
export const DISMISS_MAX = 2;
/** The statuses of a screen that waits on the person (tile-status.ts). */
const WAITING = new Set(["blocked", "permission", "question"]);

export class AgentStart {
  private quiet = 0;
  private looks = 0;
  private left = DISMISS_MAX;
  private touched = false;

  /** `def`: the agent that runs (none for a shell); `since`: when its session started. */
  constructor(private readonly def: Pick<AgentProviderDef, "dismiss"> | undefined, private readonly since: number) {}

  /** The person typed into the terminal: it is theirs from here on. */
  touch(): void {
    this.touched = true;
  }

  /** Whether a startup screen may still be skipped now: worth reading the screen for. */
  mayDismiss(now: number): boolean {
    return !!this.def?.dismiss?.length && !this.touched && this.left > 0 && now - this.since < DISMISS_WINDOW_MS;
  }

  /** The keys that skip `screen` (`hive ctl keys` tokens) when it is a startup screen the launch
   *  flags answered and one may still be skipped; null otherwise. */
  dismiss(screen: string, now: number): readonly string[] | null {
    if (!this.mayDismiss(now)) return null;
    const hit = this.def?.dismiss?.find((d) => d.match(screen));
    if (!hit) return null;
    this.left--;
    return hit.keys;
  }

  /** One look while a first task waits: whether output came since the last, and the session's
   *  status now. True when the task goes in now. */
  settled(dirty: boolean, status: string | null | undefined): boolean {
    const waiting = !!status && WAITING.has(status);
    this.looks++;
    if (dirty || waiting) this.quiet = 0;
    else this.quiet++;
    return !waiting && (this.quiet >= SETTLE_TICKS || this.looks >= DEADLINE_TICKS);
  }
}

/** Type a first task: pasted, then Enter on its own (a TUI can drop a newline that comes with the
 *  text), and Enter once more if the agent is still idle, since a fresh TUI can drop the first. */
export function typeTask(write: (data: string, paste?: boolean) => void, task: string, idle: () => boolean): void {
  write(task, true);
  setTimeout(() => write("\r"), SUBMIT_DELAY_MS);
  setTimeout(() => { if (idle()) write("\r"); }, SPAWN_SUBMIT_RETRY_MS);
}
