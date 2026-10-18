// npm run diagrams [-- <slug>]: draws every diagram in diagrams.mjs to
// scripts/diagrams/html/<slug>.html (a page to open and look at) and
// public/diagrams/<slug>.svg + .png (what the guide shows). Rerunning rewrites the same files.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import subsetFont from 'subset-font';
import { chromium } from 'playwright';
import { C } from './brand.mjs';
import diagrams from './diagrams.mjs';

const require = createRequire(import.meta.url);
const here = new URL('./', import.meta.url);
const htmlDir = new URL('html/', here);
const outDir = new URL('../../public/diagrams/', here);
mkdirSync(htmlDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// An <img> cannot load web fonts, so each SVG carries the glyphs it uses (both fonts: SIL OFL 1.1).
const fonts = {
  sans400: ['Geist', 400, '@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2'],
  sans600: ['Geist', 600, '@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2'],
  mono400: ['JetBrains Mono', 400, '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'],
};

async function fontCss(d) {
  let css = '';
  for (const [kind, [family, weight, file]] of Object.entries(fonts)) {
    const text = [...new Set(d.text[kind] + ' ')].sort().join('');
    if (text === ' ') continue;
    const woff2 = await subsetFont(readFileSync(require.resolve(file)), text, { targetFormat: 'woff2' });
    css += `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2')}`;
  }
  return css;
}

const only = process.argv[2];
const chosen = diagrams.map((make) => make()).filter((d) => !only || d.slug === only);
if (only && !chosen.length) throw new Error(`diagrams: no diagram called ${only}`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  throw new Error(`diagrams: no Chromium for Playwright; run \`npx playwright install chromium\` once.\n${e.message}`);
}
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const d of chosen) {
  const svg = d.svg(await fontCss(d));
  writeFileSync(new URL(`${d.slug}.html`, htmlDir),
    `<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${d.title}</title>` +
    `<style>body{margin:0;background:${C.paper};padding:2rem}.diagram-container{overflow-x:auto}svg{display:block;min-width:${d.w}px}</style></head>` +
    `<body><div class="diagram-container">${svg}</div></body></html>\n`);
  writeFileSync(new URL(`${d.slug}.svg`, outDir), svg);
  await page.setViewportSize({ width: d.w, height: d.h });
  await page.setContent(`<html><body style="margin:0;background:${C.paper}">${svg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('svg').screenshot({ path: new URL(`${d.slug}.png`, outDir).pathname });
  console.log(`${d.slug}.svg  ${d.w}x${d.h}`);
}
await browser.close();
