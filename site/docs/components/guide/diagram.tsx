import { readFileSync } from 'node:fs';
import path from 'node:path';

const images = path.resolve(process.cwd(), '../../guide/images');

/**
 * A diagram from guide/images/<name>.svg, drawn inline so its text is selectable and its colours
 * follow the page's light or dark theme. Narrow screens scroll it sideways instead of shrinking
 * the words past reading.
 */
export function Diagram({ name, caption }: { name: string; caption: string }) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Diagram: bad name ${name}`);
  const svg = readFileSync(path.join(images, `${name}.svg`), 'utf8');
  const width = Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 800);
  const html = svg.replace(/ width="\d+" height="\d+"/, ` style="display:block;width:100%;height:auto;min-width:${Math.round(width * 0.75)}px;max-width:${width}px;margin:0 auto"`);
  return (
    <figure className="guide-diagram not-prose my-6 rounded-xl border bg-fd-card p-2">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the guide's own SVG, drawn by site/scripts/diagrams. */}
      <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
      <figcaption className="px-2 pt-2 pb-1 text-center text-xs text-fd-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
