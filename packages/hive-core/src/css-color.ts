/**
 * The colours a look is written in (hex, rgb() and oklch()) as sRGB bytes, without a DOM: main
 * paints a window's background before its page has loaded, and needs `#rrggbb` for that.
 */

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** sRGB bytes of a CSS colour in one of the forms a palette uses; null for anything else. */
export function cssColorToRgb(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) return [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16)) as [number, number, number];
    if (hex.length === 6 || hex.length === 8) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    return null;
  }
  const fn = /^(rgba?|oklch)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  // Spaces or commas between parts; anything after a slash is alpha, which a background ignores.
  const parts = fn[2]!.split("/")[0]!.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (s: string, percentOf = 1): number => (s.endsWith("%") ? (parseFloat(s) / 100) * percentOf : parseFloat(s));
  if (fn[1] !== "oklch") {
    const rgb = parts.slice(0, 3).map((p) => Math.round(Math.min(255, Math.max(0, num(p, 255)))));
    return rgb.some(Number.isNaN) ? null : (rgb as [number, number, number]);
  }
  const l = num(parts[0]!, 1), c = num(parts[1]!, 0.4), h = (parseFloat(parts[2]!) * Math.PI) / 180;
  if ([l, c, h].some(Number.isNaN)) return null;
  // OKLCH → OKLab → linear sRGB (Björn Ottosson's matrices), then the sRGB transfer curve.
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((x) => {
    const e = clamp01(x);
    return Math.round(255 * (e <= 0.0031308 ? 12.92 * e : 1.055 * e ** (1 / 2.4) - 0.055));
  }) as [number, number, number];
}

/** `#rrggbb` for a CSS colour, or `fallback` when it cannot be read. */
export function cssColorToHex(value: string, fallback: string): string {
  const rgb = cssColorToRgb(value);
  return rgb ? `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}` : fallback;
}

const linear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 contrast ratio of two CSS colours (1 to 21), or null when either cannot be read. */
export function contrastRatio(a: string, b: string): number | null {
  const ra = cssColorToRgb(a), rb = cssColorToRgb(b);
  if (!ra || !rb) return null;
  const lum = ([r, g, bl]: [number, number, number]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(bl);
  const [hi, lo] = [lum(ra), lum(rb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A CSS colour in OKLab (`[L, a, b]`), or null when it cannot be read: how far apart two colours
 *  look is the distance between their points. */
export function cssColorToOklab(value: string): [number, number, number] | null {
  const rgb = cssColorToRgb(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
