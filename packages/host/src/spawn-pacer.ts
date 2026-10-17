/**
 * A sliding-window rate limit that makes the caller WAIT for room instead of failing.
 * The rate stays capped either way; only a backlog longer than `queueMax` is refused,
 * which is what a runaway loop looks like and a legitimate burst (restoring a large
 * workspace) never does.
 */
export function makeSpawnPacer(opts: { windowMs: number; max: number; queueMax: number }) {
  let times: number[] = [];
  let waiting = 0;
  return async function acquire(): Promise<void> {
    if (waiting >= opts.queueMax) {
      throw new Error("pty spawn rate limit exceeded — too many terminals spawned at once");
    }
    waiting++;
    try {
      for (;;) {
        const now = Date.now();
        times = times.filter((t) => now - t < opts.windowMs);
        if (times.length < opts.max) { times.push(now); return; }
        await new Promise<void>((r) => setTimeout(r, times[0]! + opts.windowMs - now + 5));
      }
    } finally {
      waiting--;
    }
  };
}
