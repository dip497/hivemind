// npm run diagrams [-- <slug>]: draws every diagram in diagrams.mjs to
// guide/images/<slug>.svg (what the guide shows, inline, in the page's theme) and
// scripts/diagrams/html/<slug>.html (a page to open and look at), with a light and a dark PNG
// beside the HTML page. Rerunning rewrites the same files.
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { resolved } from './brand.mjs';
import diagrams from './diagrams.mjs';

const here = new URL('./', import.meta.url);
const htmlDir = new URL('html/', here);
const outDir = new URL('../../../guide/images/', here);
mkdirSync(htmlDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

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
const [light, dark] = [resolved('light'), resolved('dark')];
for (const d of chosen) {
  const svg = d.svg();
  writeFileSync(new URL(`${d.slug}.svg`, outDir), `${svg}\n`);
  writeFileSync(new URL(`${d.slug}.html`, htmlDir),
    `<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${d.title}</title>` +
    `<style>body{margin:0;background:${light.paper};padding:2rem}@media (prefers-color-scheme:dark){body{background:${dark.paper}}}` +
    `.diagram-container{overflow-x:auto}svg{display:block;width:100%;height:auto;min-width:${Math.round(d.w * 0.75)}px;max-width:${d.w}px}</style></head>` +
    `<body><div class="diagram-container">${svg}</div></body></html>\n`);
  await page.setViewportSize({ width: d.w, height: d.h });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    // The file on its own: svg:root gives it the guide's tokens for the scheme.
    await page.goto(new URL(`${d.slug}.svg`, outDir).href);
    await page.screenshot({ path: new URL(`${d.slug}${scheme === 'dark' ? '-dark' : ''}.png`, htmlDir).pathname });
  }
  console.log(`${d.slug}.svg  ${d.w}x${d.h}`);
}
await browser.close();
