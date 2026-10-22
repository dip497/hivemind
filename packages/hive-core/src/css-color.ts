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
