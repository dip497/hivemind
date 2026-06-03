/**
 * Deterministic per-frame accent color.
 *
 * Every frame (repo, ad-hoc group, or worktree sub-frame) gets its OWN distinct
 * hue, hashed from its id — so workspaces and branches are visually separable on
 * the canvas, in the frame header, and in the Layers panel. OKLCH at a fixed
 * lightness/chroma keeps every hue equally vivid and legible on the dark
 * background; the hue ramp is spaced to avoid neighbour collisions and steers
 * clear of the issue STATE colors. Hashing by id makes the color STABLE across
 * reloads (no flicker) while still feeling "random" per frame.
 *
 * The frame header's color picker (`updateFrameColor`) still overrides this.
 */

// Distinct, dark-bg-legible hues (deg). Indigo · blue · cyan · teal · green ·
// lime · amber · orange · red · pink · violet — 11 well-separated stops.
const FRAME_HUES = [264, 222, 196, 172, 146, 110, 70, 40, 14, 338, 300];

/** FNV-1a → an index into FRAME_HUES. Stable for a given seed. */
function hashIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}

/** Stable distinct accent color for a frame id (CSS oklch string). */
export function frameColorFor(seed: string): string {
  const hue = FRAME_HUES[hashIndex(seed, FRAME_HUES.length)];
  return `oklch(0.7 0.14 ${hue})`;
}

/**
 * The pre-randomization default every frame used to be stamped with. Persisted
 * frames carrying this exact value are migrated to a hashed color on load (a
 * user who picked their own color via the header swatch keeps it).
 */
export const LEGACY_FRAME_COLOR = "var(--color-brand)";
