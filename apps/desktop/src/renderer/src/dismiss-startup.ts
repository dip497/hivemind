/**
 * Screens a CLI shows at startup that the host has already answered on its command line.
 *
 * An agent that gates its own hooks behind a review opens that review before it will take a
 * task — even when the launch flags say to run the hooks anyway, which makes the answer
 * decorative. The manifest names such a screen and the key that skips it (never the key that
 * grants anything), and this decides whether sending it is still allowed.
 *
 * It is allowed only at the start of a session, only before the person has touched the tile,
 * and only a couple of times: past that the screen is the agent's, not ours.
 */
export const DISMISS_WINDOW_MS = 90_000;
export const DISMISS_MAX = 2;

export interface DismissState {
  /** When the session started. */
  since: number;
  /** How many dismissals are left this session. */
  left: number;
  /** The person has typed into this tile: it is theirs from here on. */
  touched: boolean;
}

export function newDismissState(now: number): DismissState {
  return { since: now, left: DISMISS_MAX, touched: false };
}

/** May the host answer a matched startup screen right now? */
export function mayDismiss(s: DismissState, now: number): boolean {
  return !s.touched && s.left > 0 && now - s.since < DISMISS_WINDOW_MS;
}
