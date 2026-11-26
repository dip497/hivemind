/**
 * The Code tile's timing for questions about code: the outline is read once typing has stopped
 * for a moment, never per keystroke; and one question of a kind is open at a time, so asking
 * again or moving the cursor takes back the one before.
 */

/** A question that can be taken back. */
export interface Cancellable { answer: Promise<unknown>; cancel(): void }

/** One open question at a time: a new one, or `cancel()`, takes back the one before, and only the
 *  open one's answer or failure reaches `done` or `failed`. */
export class OneAtATime {
  private current: Cancellable | null = null;

  start<T>(asked: { answer: Promise<T>; cancel(): void }, done: (answer: T) => void, failed: (error: unknown) => void): void {
    this.current?.cancel();
    this.current = asked;
    const open = () => {
      if (this.current !== asked) return false;
      this.current = null;
      return true;
    };
    asked.answer.then((a) => { if (open()) done(a); }, (e) => { if (open()) failed(e); });
  }

  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }
}

/** Runs `run` once `ms` after the last `poke()`; a poke only moves a timer. */
export class AfterTyping {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ms: number, private readonly run: () => void) {}

  poke(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.run(); }, this.ms);
  }

  /** Run now, without waiting (the outline was just opened). */
  now(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.run();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
