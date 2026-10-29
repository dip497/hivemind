/** A soft round glow, bright in its middle and gone at its edge, in one colour: drawn scaled behind
 *  a jelly or round a firefly, once per look, never per frame. */
import { cssAlpha, type Rgb } from "./colour";

export function glowSprite(colour: Rgb, size = 64): OffscreenCanvas {
  const sprite = new OffscreenCanvas(size, size);
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, cssAlpha(colour, 1));
  grad.addColorStop(0.25, cssAlpha(colour, 0.55));
  grad.addColorStop(0.6, cssAlpha(colour, 0.14));
  grad.addColorStop(1, cssAlpha(colour, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}
