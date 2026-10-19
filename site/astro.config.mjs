import { defineConfig } from 'astro/config';
// Served from the root of its domain; the guide is built separately into /guide (scripts/add-guide.mjs).
// Styles go inline, so the first paint waits on no stylesheet request.
export default defineConfig({
  site: process.env.SITE_URL || 'https://hivemind.griiken.com',
  build: { inlineStylesheets: 'always' },
});
