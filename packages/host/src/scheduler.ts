/**
 * A task run on a fixed beat while something needs it: started when there is work, stopped when
 * there is none, so an idle host keeps no timer. Never two runs at once: the next is armed when
 * the last has ended. Its timers never keep the process alive. Electron-free.
 */
export class Repeating {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private on = false;
  private going: Promise<void> | null = null;

  constructor(
    private readonly task: () => Promise<unknown>,
    private readonly everyMs: number,
    private readonly failed: (e: unknown) => void = () => {},
  ) {}

  get started(): boolean {
    return this.on;
  }

  /** Run every `everyMs`, the first after `firstMs`. Started already: nothing changes. */
  start(firstMs = this.everyMs): void {
    if (this.on) return;
    this.on = true;
    if (!this.going) this.arm(firstMs);
  }

  stop(): void {
    this.on = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.going = (async () => {
        try {
          await this.task();
        } catch (e) {
          this.failed(e);
        } finally {
          this.going = null;
          if (this.on) this.arm(this.everyMs);
        }
      })();
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
