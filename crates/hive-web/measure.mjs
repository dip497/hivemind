// Open www/index.html in headless Chromium and print what it measured, as JSON.
//   node measure.mjs <page url> <relay url> <host id> [messages]
// Playwright is the desktop app's; PLAYWRIGHT_FROM names another package.json to find it from,
// CHROMIUM a browser binary other than the one Playwright pins.
import { createRequire } from 'node:module';

const [page, relay, host, n = '200'] = process.argv.slice(2);
if (!host) {
  console.error('usage: node measure.mjs <page url> <relay url> <host id> [messages]');
  process.exit(2);
}
const require = createRequire(
  process.env.PLAYWRIGHT_FROM ?? new URL('../../apps/desktop/package.json', import.meta.url),
);
const { chromium } = require('@playwright/test');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
try {
  const tab = await browser.newPage();
  tab.on('console', (m) => m.type() === 'error' && console.error(m.text()));
  const query = new URLSearchParams({ relay, host, n, run: '1' });
  await tab.goto(`${page}?${query}`);
  await tab.waitForFunction(() => window.result, null, { timeout: 30_000 });
  console.log(JSON.stringify(await tab.evaluate(() => window.result), null, 2));
} finally {
  await browser.close();
}
