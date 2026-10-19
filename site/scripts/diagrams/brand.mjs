// The diagrams' colours: roles drawn from the guide's own tokens (site/docs/app/global.css).
// In a guide page the SVG sits inline and follows the page's light or dark theme; opened on its
// own, it falls back to the same tokens resolved to plain colours.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../docs/app/global.css', import.meta.url), 'utf8');

function block(re, from) {
  const m = css.match(re);
  if (!m) throw new Error(`diagrams: no ${from} block in site/docs/app/global.css`);
  return Object.fromEntries([...m[1].matchAll(/--color-fd-([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}
const fixed = block(/@theme static\s*\{([^}]*)\}/, '@theme static');
const light = { ...block(/@theme\s*\{([^}]*)\}/, '@theme'), ...fixed };
const dark = { ...block(/\n\.dark\s*\{([^}]*)\}/, '.dark'), ...fixed };

const parse = (value, from) => {
  const m = value?.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`diagrams: ${from} is not a plain oklch() colour: ${value}`);
  return m.slice(1).map(Number);
};

function oklchToHex([L, Cc, H]) {
  const h = (H * Math.PI) / 180, a = Cc * Math.cos(h), b = Cc * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const gamma = (x) => { x = Math.max(0, Math.min(1, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; };
  return '#' + rgb.map((x) => Math.round(gamma(x) * 255).toString(16).padStart(2, '0')).join('');
}

// Each role is one token, or `share` of one token mixed into another.
const ROLES = {
  paper: ['card'],
  paper2: ['foreground', 0.04, 'card'],
  ink: ['foreground'],
  muted: ['foreground', 0.7, 'muted-foreground'],
  soft: ['muted-foreground'],
  rule: ['border'],
  ruleSolid: ['foreground', 0.42, 'card'],
  accent: ['primary'],
  accentTint: ['primary', 0.1, 'card'],
  link: ['info'],
  warn: ['warning'],
  warnTint: ['warning', 0.12, 'card'],
};

const cssValue = ([a, share, b]) =>
  share === undefined
    ? `var(--color-fd-${a})`
    : `color-mix(in oklch, var(--color-fd-${a}) ${Math.round(share * 100)}%, var(--color-fd-${b}))`;

/** Every role as a CSS variable, so an attribute names `var(--d-ink)` and the theme decides. */
export const C = Object.fromEntries(Object.keys(ROLES).map((role) => [role, `var(--d-${role})`]));

/** Plain colours for one theme, for the preview pages and pictures. */
export function resolved(theme) {
  const tokens = theme === 'dark' ? dark : light;
  const one = (name) => parse(tokens[name], `--color-fd-${name}`);
  return Object.fromEntries(Object.entries(ROLES).map(([role, [a, share, b]]) => {
    if (share === undefined) return [role, oklchToHex(one(a))];
    const [x, y] = [one(a), one(b)];
    return [role, oklchToHex(x.map((v, i) => v * share + y[i] * (1 - share)))];
  }));
}

const tokenList = (tokens) =>
  [...new Set(Object.values(ROLES).flatMap(([a, , b]) => [a, b]).filter(Boolean))]
    .map((name) => `--color-fd-${name}:${oklchToHex(parse(tokens[name], name))}`).join(';');

/**
 * The style every diagram carries. Inline in a guide page, `--color-fd-*` come from the page.
 * Opened on its own the SVG is the root element, so `svg:root` gives it the tokens, light or dark.
 */
export const STYLE =
  `svg.hm-diagram{${Object.entries(ROLES).map(([role, def]) => `--d-${role}:${cssValue(def)}`).join(';')};` +
  `font-family:var(--font-sans,'Geist',ui-sans-serif,system-ui,sans-serif);text-rendering:geometricPrecision}` +
  `svg.hm-diagram .m{font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace)}` +
  `svg:root{${tokenList(light)}}` +
  `@media (prefers-color-scheme:dark){svg:root{${tokenList(dark)}}}`;
