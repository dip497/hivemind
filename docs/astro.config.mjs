import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
const base = (process.env.SITE_BASE ?? '/hivemind').replace(/\/$/, '');
export default defineConfig({
  site: process.env.SITE_URL || 'https://dip497.github.io',
  base: base || '/',
  integrations: [starlight({
    title: 'Hivemind',
    favicon: '/icon.png',
    logo: { src: './public/icon.png', replacesTitle: false },
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/dip497/hivemind' }],
    customCss: ['./src/styles/docs.css'],
    sidebar: [
      { label: 'Start here', items: [{ label: 'Introduction', slug: 'guide' }, { label: 'Installation', slug: 'guide/getting-started' }] },
      { label: 'Use Hivemind', items: ['guide/workspaces', 'guide/agents', 'guide/views', 'guide/appearance'] },
      { label: 'For agents', items: ['guide/agent-workflows', 'guide/cli'] },
      { label: 'Build with Hivemind', items: ['guide/packages', 'guide/extension-authoring', 'guide/contributing', 'guide/troubleshooting'] },
    ],
    head: [{ tag: 'link', attrs: { rel: 'alternate', type: 'text/markdown', href: `${base}/llms.txt` } }],
  })],
});
