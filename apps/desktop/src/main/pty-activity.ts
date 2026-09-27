/**
 * Per-tile output level for views (protocol 1.3): live pty bytes → a moving average of bytes/s →
 * one of four levels. Only watched tiles are sampled, and only changes are reported. A level, never
 * a count: exact bytes would leak output length and echo timing.
 */
export type Level = 0 | 1 | 2 | 3;

export const SAMPLE_MS = 250;
/** bytes/s upper bounds for levels 0, 1 and 2; anything above is 3. */
export const THRESHOLDS = [32, 1024, 16 * 1024] as const;
const SMOOTHING = 0.5;
/** A lower level must hold this many samples before it is reported, so pauses do not flicker. */
const DROP_HOLD = 2;

export function levelFor(bytesPerSecond: number): Level {
  if (bytesPerSecond < THRESHOLDS[0]) return 0;
  if (bytesPerSecond < THRESHOLDS[1]) return 1;
  if (bytesPerSecond < THRESHOLDS[2]) return 2;
  return 3;
}

interface Track { bytes: number; rate: number; level: Level; lower: number }

export class ActivityMeter {
  private tracks = new Map<string, Track>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onChange: (levels: Record<string, Level>) => void,
    private timers: { start: (fn: () => void, ms: number) => ReturnType<typeof setInterval>; stop: (t: ReturnType<typeof setInterval>) => void } = {
      start: (fn, ms) => setInterval(fn, ms),
      stop: (t) => clearInterval(t),
    },
  ) {}

  /** Live output only; a reattach replay must not reach here. */
  note(tileId: string, bytes: number): void {
    const t = this.tracks.get(tileId);
    if (t) t.bytes += bytes;
  }

  setWatched(tileIds: readonly string[]): void {
    const next = new Set(tileIds);
    for (const id of this.tracks.keys()) if (!next.has(id)) this.tracks.delete(id);
    for (const id of next) if (!this.tracks.has(id)) this.tracks.set(id, { bytes: 0, rate: 0, level: 0, lower: 0 });
    if (this.tracks.size && !this.timer) this.timer = this.timers.start(() => this.sample(), SAMPLE_MS);
    else if (!this.tracks.size && this.timer) { this.timers.stop(this.timer); this.timer = null; }
  }

  level(tileId: string): Level { return this.tracks.get(tileId)?.level ?? 0; }

  get sampling(): boolean { return this.timer !== null; }

  sample(): void {
    const changed: Record<string, Level> = {};
    for (const [id, t] of this.tracks) {
      t.rate = SMOOTHING * t.rate + (1 - SMOOTHING) * (t.bytes * 1000) / SAMPLE_MS;
      t.bytes = 0;
      const want = levelFor(t.rate);
      if (want > t.level) { t.level = want; t.lower = 0; changed[id] = want; }
      else if (want < t.level) {
        if (++t.lower >= DROP_HOLD) { t.level = want; t.lower = 0; changed[id] = want; }
      } else t.lower = 0;
    }
    if (Object.keys(changed).length) this.onChange(changed);
  }

  dispose(): void { this.setWatched([]); }
}
