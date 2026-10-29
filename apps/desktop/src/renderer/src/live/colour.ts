/**
 * The scenes' own colours (Colour on): set in OKLCH, so a palette's lightness reads as it is set
 * on any hue, and turned into the sRGB a canvas draws once per palette, never per frame. A colour
 * the screen cannot show keeps its lightness and hue and loses chroma until it can.
 */

/** Lightness 0–1, chroma 0–0.37, hue in degrees. */
export type Oklch = readonly [l: number, c: number, h: number];
/** sRGB, each 0–255. */
export type Rgb = readonly [r: number, g: number, b: number];

/** Steps in a ramp: as many as the scenes' tone model (shoal/render.ts) uses. */
export const RAMP = 64;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToLab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const inGamut = (c: readonly number[]) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** An OKLCH colour as sRGB, its chroma cut to the screen's gamut where it is out of it. */
export function rgbOf([l, c, h]: Oklch): Rgb {
  const at = (chroma: number) => labToLinear(l, chroma * Math.cos((h * Math.PI) / 180), chroma * Math.sin((h * Math.PI) / 180));
  let lin = at(c);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return lin.map((v) => Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255)) as unknown as Rgb;
}

/** 0xRRGGBB as sRGB. */
export const rgbOfHex = (n: number): Rgb => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

/** `t` of the way from `a` to `b`, in OKLab: an even step in lightness, with no grey dip between hues. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const [la, aa, ba] = linearToLab(...(a.map((v) => toLinear(v / 255)) as [number, number, number]));
  const [lb, ab, bb] = linearToLab(...(b.map((v) => toLinear(v / 255)) as [number, number, number]));
  const lin = labToLinear(la + (lb - la) * t, aa + (ab - aa) * t, ba + (bb - ba) * t);
  return lin.map((v) => Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255)) as unknown as Rgb;
}

export const css = ([r, g, b]: Rgb) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
export const cssAlpha = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${+a.toFixed(3)})`;
/** As one pixel of an ImageData (RGBA bytes, read little-endian). */
export const pixelOf = ([r, g, b]: Rgb) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** RAMP + 1 steps from `from` to `to`, as fill styles and as pixels. */
export interface Ramp {
  styles: string[];
  pixels: Uint32Array;
}

export function ramp(from: Rgb, to: Rgb): Ramp {
  const styles: string[] = [];
  const pixels = new Uint32Array(RAMP + 1);
  for (let i = 0; i <= RAMP; i++) {
    const c = mix(from, to, i / RAMP);
    styles.push(css(c));
    pixels[i] = pixelOf(c);
  }
  return { styles, pixels };
}

/** WCAG relative luminance. */
export const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((v) => toLinear(v / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
