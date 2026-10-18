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
      { label: 'Get started', items: [
        { label: 'Introduction', slug: 'guide' },
        { label: 'Install and first agent', slug: 'guide/getting-started' },
      ] },
      { label: 'Use Hivemind', items: [
        { label: 'The workspace', items: ['guide/workspaces', 'guide/views', 'guide/issues', 'guide/review'] },
        { label: 'Agents', items: ['guide/agents', 'guide/agent-workflows'] },
        { label: 'Other computers', items: ['guide/machines', 'guide/host'] },
        { label: 'People and devices', items: ['guide/connect', 'guide/multiplayer', 'guide/phone', 'guide/self-hosting'] },
        'guide/appearance',
      ] },
      { label: 'Extend', items: ['guide/plugins', 'guide/agent-providers', 'guide/extension-authoring', 'guide/widgets', 'guide/tool-plugins'] },
      { label: 'API', items: ['guide/api', 'guide/api-tokens', 'guide/api-connect', 'guide/api-methods'] },
      { label: 'Reference', items: ['guide/cli', 'guide/troubleshooting', 'guide/contributing'] },
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
