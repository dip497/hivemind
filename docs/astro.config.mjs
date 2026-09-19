import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
const base = (process.env.SITE_BASE ?? '/hivemind').replace(/\/$/, '');
export default defineConfig({
  site: process.env.SITE_URL || 'https://hivemind.griiken.com',
  base: base || '/',
  integrations: [starlight({
    title: 'Hivemind',
    // No search: see src/components/NoSearch.astro.
    pagefind: false,
    components: { Search: './src/components/NoSearch.astro', ThemeSelect: './src/components/NoThemeSelect.astro' },
    favicon: '/favicon.svg',
    logo: { light: './public/mark.svg', dark: './public/mark-dark.svg', replacesTitle: false },
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/dip497/hivemind' }],
    customCss: ['./src/styles/docs.css'],
    sidebar: [
      { label: 'Start here', items: [{ label: 'Introduction', slug: 'guide' }, { label: 'Getting started', slug: 'guide/getting-started' }] },
      { label: 'Use Hivemind', items: ['guide/workspaces', 'guide/agents', 'guide/agent-providers', 'guide/views', 'guide/appearance'] },
      { label: 'For agents', items: ['guide/agent-workflows', 'guide/cli'] },
      { label: 'Build with Hivemind', items: ['guide/packages', 'guide/extension-authoring', 'guide/contributing', 'guide/troubleshooting'] },
    ],
    head: [
      { tag: 'link', attrs: { rel: 'alternate', type: 'text/markdown', href: `${base}/llms.txt` } },
      // One theme, set before paint. There is no picker, so nothing can flip it later.
      { tag: 'script', content: "try{localStorage.setItem('starlight-theme','dark')}catch(e){};document.documentElement.dataset.theme='dark'" },
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
      { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap' } },
    ],
  })],
});
