// The hero's stills, made into AVIF and WebP at build time. The wide ones are the whole window;
// the phone ones are a 4:5 crop that follows the action. Both the page head (to preload the
// poster) and the hero itself read them from here, so they always name the same files.
import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';

const files = import.meta.glob<{ default: ImageMetadata }>('../assets/hero/*.webp', { eager: true });
const source = (name: string) => {
  const file = files[`../assets/hero/${name}.webp`];
  if (!file) throw new Error(`no hero still ${name}.webp: run apps/desktop/scripts/site-clip-encode.mjs`);
  return file.default;
};

/** The frame is the page column wide (1176 px) and the full width on a phone. */
export const WIDE_SIZES = '(max-width: 640px) 100vw, min(1176px, 100vw - 64px)';
export const PHONE_SIZES = 'calc(100vw - 32px)';
export const PHONE_QUERY = '(max-width: 640px)';
const WIDE_WIDTHS = [960, 1440, 1920, 2560];
const PHONE_WIDTHS = [480, 720, 1000];

export type Still = { avif: string; webp: string; src: string; width: number; height: number };

async function still(name: string, widths: number[], webp: boolean): Promise<Still> {
  const src = source(name);
  const use = widths.filter((w) => w <= src.width);
  const [a, w] = await Promise.all([
    getImage({ src, widths: use, format: 'avif', quality: 62 }),
    webp ? getImage({ src, widths: use, format: 'webp', quality: 82 }) : null,
  ]);
  return { avif: a.srcSet.attribute, webp: w?.srcSet.attribute ?? '', src: w?.src ?? a.src, width: src.width, height: src.height };
}

/** The poster, in AVIF and in WebP for browsers without AVIF. */
export const wideStill = (name: string) => still(name, WIDE_WIDTHS, true);
export const phoneStill = (name: string) => still(`${name}-phone`, PHONE_WIDTHS, true);
/** A step's still, fetched only when someone asks for that step without the clip. */
export const wideStep = (name: string) => still(name, WIDE_WIDTHS, false);
export const phoneStep = (name: string) => still(`${name}-phone`, PHONE_WIDTHS, false);
