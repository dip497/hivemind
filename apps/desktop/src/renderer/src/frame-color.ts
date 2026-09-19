/**
 * A frame's colour: identity, never status.
 *
 * Every frame gets its own hue, hashed from its id so it is stable across reloads. The hues
 * come only from the cool half of the wheel and sit at low chroma: warm hues are how the app
 * says "needs you" and "failed", green is "done", and a frame born amber would read as an agent
 * waiting on you. A frame colour should be recognisable as a label and never mistaken for a signal.
 *
 * The frame header's picker (`updateFrameColor`) overrides this, from the same swatches.
 */

// Teal · sky · blue · periwinkle · violet · plum · rose — clear of the warm and green bands.
const FRAME_HUES = [188, 214, 240, 264, 288, 312, 336];
const LIGHTNESS = 0.72;
const CHROMA = 0.075;

/** FNV-1a → an index. Stable for a given seed. */
function hashIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}

const identity = (hue: number) => `oklch(${LIGHTNESS} ${CHROMA} ${hue})`;

/** Stable, distinct identity colour for a frame id (CSS oklch string). */
export function frameColorFor(seed: string): string {
  return identity(FRAME_HUES[hashIndex(seed, FRAME_HUES.length)]!);
}

/** What the frame header and the rail menu offer: the same identity hues, and a neutral. */
export const FRAME_SWATCHES: readonly { name: string; value: string }[] = [
  { name: "Teal", value: identity(188) },
  { name: "Sky", value: identity(214) },
  { name: "Blue", value: identity(240) },
  { name: "Periwinkle", value: identity(264) },
  { name: "Violet", value: identity(288) },
  { name: "Plum", value: identity(312) },
  { name: "Rose", value: identity(336) },
  { name: "Slate", value: "oklch(0.66 0.012 250)" },
];

/**
 * The pre-randomization default every frame used to be stamped with. Persisted
 * frames carrying this exact value are migrated to a hashed color on load (a
 * user who picked their own color via the header swatch keeps it).
 */
export const LEGACY_FRAME_COLOR = "var(--color-brand)";

/** A colour this app generated automatically in an earlier version — not one a person chose. */
export function isGeneratedFrameColor(color: string): boolean {
  return color === LEGACY_FRAME_COLOR || /^oklch\(0\.7 0\.14 \d+(\.\d+)?\)$/.test(color);
}
