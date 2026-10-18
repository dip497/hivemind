// The diagrams' colours, read from the site's own tokens so a brand change redraws them.
import { readFileSync } from 'node:fs';

const site = new URL('../../', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('src/generated/tokens.json', site), 'utf8')).tokens;
const css = readFileSync(new URL('src/styles/docs.css', site), 'utf8');
// The dark block comes first in docs.css and the site is dark only, so the first match is the one.
const fromCss = (name) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
const fromTokens = (name) => tokens[name]?.value;

function oklchToHex(value, from) {
  const m = value?.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`diagrams: ${from} is not a plain oklch() colour: ${value}`);
  const [L, Cc, H] = m.slice(1).map(Number);
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

const token = (name) => oklchToHex(fromTokens(name), `tokens.json ${name}`);
const style = (name) => oklchToHex(fromCss(name), `docs.css --${name}`);

export const C = {
  paper: token('color-bg'),
  ink: token('color-fg'),
  muted: token('color-fg2'),
  soft: token('color-fg3'),
  rule: token('color-line'),
  link: token('color-accent'),
  paper2: style('hm-surface'),
  accent: style('hm-accent'),
  accentTint: style('hm-accent-soft'),
  // Not a site token: a node border lightened from --color-line2 until it clears 3:1 on paper.
  ruleSolid: '#616467',
};
