import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
const base = (process.env.SITE_BASE ?? '/hivemind').replace(/\/$/, '');
export default defineConfig({
  site: process.env.SITE_URL || 'https://dip497.github.io',
  base: base || '/',
  integrations: [starlight({
    title: 'Hivemind',
    favicon: '/favicon.svg',
    logo: { light: './public/mark.svg', dark: './public/mark-dark.svg', replacesTitle: false },
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/dip497/hivemind' }],
    customCss: ['./src/styles/docs.css'],
    sidebar: [
      { label: 'Start here', items: [{ label: 'Introduction', slug: 'guide' }, { label: 'Installation', slug: 'guide/getting-started' }] },
      { label: 'Use Hivemind', items: ['guide/workspaces', 'guide/agents', 'guide/agent-providers', 'guide/views', 'guide/appearance'] },
      { label: 'For agents', items: ['guide/agent-workflows', 'guide/cli'] },
      { label: 'Build with Hivemind', items: ['guide/packages', 'guide/extension-authoring', 'guide/contributing', 'guide/troubleshooting'] },
    ],
    head: [
      { tag: 'link', attrs: { rel: 'alternate', type: 'text/markdown', href: `${base}/llms.txt` } },
      // Default to the printed page. Starlight otherwise follows the OS, which
      // lands most people in the night edition without ever choosing it.
      { tag: 'script', content: "try{if(!localStorage.getItem('starlight-theme')){localStorage.setItem('starlight-theme','light');document.documentElement.dataset.theme='light'}}catch(e){}" },
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
      { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap' } },
    ],
  })],
});
