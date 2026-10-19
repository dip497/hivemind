import { defineConfig } from 'astro/config';
// Served from the root of its domain; the guide is built separately into /guide (scripts/add-guide.mjs).
export default defineConfig({
  site: process.env.SITE_URL || 'https://hivemind.griiken.com',
});
