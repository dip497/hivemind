/**
 * The colours a look is written in (hex, rgb() and oklch()) as sRGB bytes, without a DOM: main
 * paints a window's background before its page has loaded, and needs `#rrggbb` for that.
 */

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// Each pattern here reads a string in one pass: a colour comes from a theme or a package (main and
// the hub read them), so no part may match two ways (`\d+\.?\d*` took quadratic time on a long run
// of digits, and `\s*([^()]*?)\s*` cubic time on a long run of spaces).
const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const NUMBER = new RegExp(`^${NUM}$`);
const PERCENT = new RegExp(`^${NUM}%$`);
const ANGLE = new RegExp(`^(${NUM})(deg|rad|grad|turn)?$`);
/** Degrees in one turn of each unit CSS allows for a hue; a bare number is degrees. */
const TURN: Record<string, number> = { deg: 360, rad: 2 * Math.PI, grad: 400, turn: 1 };

/** A number or a percentage of `whole`; null for anything else. */
function amount(s: string, whole: number, number = true): number | null {
  if (PERCENT.test(s)) return (parseFloat(s) / 100) * whole;
  return number && NUMBER.test(s) ? parseFloat(s) : null;
}

/** A CSS colour in one of the forms a palette uses, read as CSS reads it: sRGB bytes, and whether
 *  it carries an alpha (`#rgba`, `#rrggbbaa`, a fourth argument or `/ alpha`). Null for anything
 *  CSS would paint differently or not at all: a missing or extra part, a unit a part does not take,
 *  text after the colour. */
export function parseCssColor(value: string): { rgb: [number, number, number]; alpha: boolean } | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]+)$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) return { rgb: [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16)) as [number, number, number], alpha: hex.length === 4 };
    if (hex.length === 6 || hex.length === 8) return { rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number], alpha: hex.length === 8 };
    return null;
  }
  const fn = /^(rgba?|oklch)\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const body = fn[2]!.trim();
  let parts: string[], alpha: string | undefined;
  if (fn[1] !== "oklch" && body.includes(",")) {
    // The legacy form: three parts, all numbers or all percentages, and an optional fourth, alpha.
    parts = body.split(",").map((x) => x.trim());
    if (parts.length === 4) alpha = parts.pop();
    if (parts.length !== 3 || parts.some((x) => !x || /\s/.test(x))) return null;
    if (!parts.every((x) => NUMBER.test(x)) && !parts.every((x) => PERCENT.test(x))) return null;
  } else {
    // The modern form: three parts between spaces, and `/ alpha`.
    const [main, a, ...more] = body.split("/").map((x) => x.trim());
    if (more.length || a === "") return null;
    alpha = a;
    parts = main!.split(/\s+/).filter(Boolean);
    if (parts.length !== 3) return null;
  }
  if (alpha !== undefined && amount(alpha, 1) === null) return null;
  const hasAlpha = alpha !== undefined;
  if (fn[1] !== "oklch") {
    const rgb = parts.map((p) => amount(p, 255));
    if (rgb.some((x) => x === null)) return null;
    return { rgb: rgb.map((x) => Math.round(Math.min(255, Math.max(0, x!)))) as [number, number, number], alpha: hasAlpha };
  }
  const l = amount(parts[0]!, 1), c = amount(parts[1]!, 0.4);
  const angle = ANGLE.exec(parts[2]!);
  if (l === null || c === null || !angle) return null;
  const h = (parseFloat(angle[1]!) / TURN[angle[2] ?? "deg"]!) * 2 * Math.PI;
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
  return {
    rgb: lin.map((x) => {
      const e = clamp01(x);
      return Math.round(255 * (e <= 0.0031308 ? 12.92 * e : 1.055 * e ** (1 / 2.4) - 0.055));
    }) as [number, number, number],
    alpha: hasAlpha,
  };
}

/** sRGB bytes of a CSS colour in one of the forms a palette uses (`parseCssColor`), alpha set
 *  aside; null for anything else. */
export function cssColorToRgb(value: string): [number, number, number] | null {
  return parseCssColor(value)?.rgb ?? null;
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
