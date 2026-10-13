import { renderMermaidSVG } from 'beautiful-mermaid';

// ```mermaid title="Caption" becomes an inline SVG at build time; the page ships no script.
// Colours and fonts come from docs.css (.diagram), so each SVG's own <style> is dropped.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function figure(source, title, id) {
  const svg = renderMermaidSVG(source, { bg: 'var(--hm-sunk)', fg: 'var(--hm-body)', font: 'Geist', padding: 8, transparent: true })
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    // Marker ids repeat in every diagram; give each diagram its own.
    .replace(/ id="([^"]+)"/g, ` id="${id}-$1"`)
    .replace(/url\(#/g, `url(#${id}-`)
    .replace(/href="#/g, `href="#${id}-`)
    .replace('<svg ', `<svg role="img" aria-label="${esc(title ?? 'Diagram')}" `);
  // Shrunk to a phone, text stays readable at 80% or more; the figure scrolls past that.
  const width = Number(svg.match(/ width="([\d.]+)"/)?.[1]);
  const floor = width ? ` style="--min:${Math.round(width * 0.8)}px"` : '';
  return `<figure class="diagram"${floor}>${svg}${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
}

// A Sätteri mdast plugin (Astro 7's Markdown processor); the factory runs once per page.
const plugin = (ctx) => {
  let n = 0;
  return {
    name: 'mermaid',
    code(node) {
      if (node.lang !== 'mermaid') return;
      n++;
      try {
        return { type: 'html', value: figure(node.value, node.meta?.match(/title="([^"]*)"/)?.[1], `d${n}`) };
      } catch (e) {
        throw new Error(`${ctx.fileURL?.pathname}: mermaid diagram ${n}: ${e.message}`);
      }
    },
  };
};

export default function mermaid() {
  return {
    name: 'mermaid',
    hooks: {
      'astro:config:setup': ({ config }) => config.markdown.processor.options.mdastPlugins.push(plugin),
    },
  };
}
