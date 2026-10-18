// A day of the workspace as bars: each tile's statuses from the app's history, kept going live,
// and what the day adds up to. No screen needed, so it can be checked on its own.

const DAY_STATES = ["working", "blocked", "idle", "exited", "unknown"];

/** A tile's intervals with its live status added: the last one runs on to `now`, and a change
 *  starts a new one. */
export function extend(intervals, status, at, now) {
  const out = intervals.map((i) => [...i]);
  const last = out[out.length - 1];
  if (last && last[2] === status) { last[1] = Math.max(last[1], now); return out; }
  if (last) last[1] = Math.min(Math.max(last[1], at), now);
  out.push([at, now, status]);
  return out;
}

/** Minutes in each status, for one tile's intervals, clipped to [from, to]. */
export function minutesIn(intervals, from = -Infinity, to = Infinity) {
  const out = Object.fromEntries(DAY_STATES.map((s) => [s, 0]));
  for (const [a, b, s] of intervals) {
    const ms = Math.max(0, Math.min(b, to) - Math.max(a, from));
    if (s in out) out[s] += ms / 60_000;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10) / 10;
  return out;
}

/** The span to show: from a little before the first thing that happened to now, at least `min`. */
export function span(tiles, now, min = 10 * 60_000) {
  let first = now;
  for (const t of tiles) for (const [a] of t.intervals) first = Math.min(first, a);
  const from = Math.min(first - (now - first) * 0.05, now - min);
  return { from, to: now + (now - from) * 0.02 };
}

/** Round times to label the axis at: about `n` of them, on whole minutes, quarters or hours. */
export function ticks(from, to, n = 6) {
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000];
  const step = steps.find((s) => (to - from) / s <= n) ?? steps[steps.length - 1];
  const out = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}
