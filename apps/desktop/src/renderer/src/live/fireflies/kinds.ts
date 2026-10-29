/**
 * Fireflies' fireflies: each program's agents one species, known by the colour of its light and
 * the code it flashes, as real fireflies are (Photinus pyralis' long J, P. carolinus' bursts in
 * time with each other, the blue ghost's steady glow …).
 */
export type FireflyKind = "pyralis" | "carolinus" | "ghost" | "photuris" | "lime" | "ember" | "teal" | "pale";

/** The kinds, in the order an agent's variant picks them. */
export const FIREFLY_KINDS: FireflyKind[] = ["pyralis", "carolinus", "ghost", "photuris", "lime", "ember", "teal", "pale"];

/** 0 to 1 and back over `x` from 0 to 1, smoothly; 0 outside it. */
const bump = (x: number) => (x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x) ** 2);

/** How bright a kind's light is `t` seconds into its code, 0 to 1. */
export const FLASHES: Record<FireflyKind, (t: number) => number> = {
  // One long flash, then dark for five seconds.
  pyralis: (t) => bump((t % 5.5) / 0.7),
  // A burst of six quick flashes, then dark: P. carolinus flashes in time with its neighbours.
  carolinus: (t) => {
    const p = t % 7;
    return p < 3 ? bump((p % 0.5) / 0.22) : 0;
  },
  // The blue ghost glows, steady, breathing.
  ghost: (t) => 0.55 + 0.2 * Math.sin(t * 1.3),
  // Two quick flashes, again and again.
  photuris: (t) => {
    const p = t % 2.4;
    return bump(p / 0.18) + bump((p - 0.36) / 0.18);
  },
  // One short flash, often.
  lime: (t) => bump((t % 1.7) / 0.25),
  // A slow swell.
  ember: (t) => bump((t % 3.6) / 1.4),
  // Three flashes, then dark.
  teal: (t) => {
    const p = t % 4.2;
    return bump(p / 0.16) + bump((p - 0.3) / 0.16) + bump((p - 0.6) / 0.16);
  },
  // A flicker.
  pale: (t) => {
    const p = t % 2.9;
    return p < 0.9 ? 0.4 + 0.6 * bump((p % 0.3) / 0.3) : 0.08;
  },
};

/** A firefly whose agent needs you: two bright flashes close together, over and over, whatever its
 *  kind. */
export const CALL = (t: number) => {
  const p = t % 1.1;
  return Math.min(1, bump(p / 0.2) + bump((p - 0.3) / 0.2));
};
