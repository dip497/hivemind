// The hero's still, made into AVIF and WebP at build time. The page head (to preload it) and the
// hero itself both read it from here, so they always name the same files.
import { getImage } from 'astro:assets';
import school from '../assets/hero/school-of-agents.webp';

/** The frame is the page column wide (1176 px), and the full width less the gutters on a phone. */
export const HERO_SIZES = '(max-width: 640px) calc(100vw - 32px), min(1176px, 100vw - 64px)';
const WIDTHS = [640, 960, 1280];

export async function heroStill() {
  const [avif, webp] = await Promise.all([
    getImage({ src: school, widths: WIDTHS, format: 'avif', quality: 62 }),
    getImage({ src: school, widths: WIDTHS, format: 'webp', quality: 82 }),
  ]);
  return { avif: avif.srcSet.attribute, webp: webp.srcSet.attribute, src: webp.src, width: school.width, height: school.height };
}
