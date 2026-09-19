/** A terminal that holds a WebGL slot renders with WebGL. DOM is only a fallback:
 *  (a) during a WebGL context-loss cooldown, or (b) when the slot manager has no
 *  slot for the tile (budget / off-screen — off-screen tiles don't paint anyway). */

export interface RendererInputs {
  now: number;
  /** After a lost WebGL context, re-acquiring just loses it again. */
  webglCooldownUntil: number;
}

export function wantsDomRenderer({ now, webglCooldownUntil }: RendererInputs): boolean {
  return now < webglCooldownUntil;
}
