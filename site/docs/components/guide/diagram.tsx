import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const images = path.resolve(process.cwd(), '../../guide/images');

// Drawn at its own width so no word shrinks below its size; a narrower screen scrolls it.
function inline(file: string) {
  const svg = readFileSync(file, 'utf8');
  const width = Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1] ?? 800);
  return svg.replace(/ width="\d+" height="\d+"/, ` style="display:block;width:${width}px;max-width:none;height:auto;margin:0 auto"`);
}

/**
 * A diagram from guide/images/<name>.svg, drawn inline so its text is selectable and its colours
 * follow the page's light or dark theme. A <name>-phone.svg, when there is one, replaces it on
 * phone screens.
 */
export function Diagram({ name, caption }: { name: string; caption: string }) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Diagram: bad name ${name}`);
  const phone = path.join(images, `${name}-phone.svg`);
  const hasPhone = existsSync(phone);
  return (
    <figure className="guide-diagram not-prose my-6 rounded-xl border bg-fd-card p-2">
      <div
        className={hasPhone ? 'overflow-x-auto max-sm:hidden' : 'overflow-x-auto'}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the guide's own SVG, drawn by site/scripts/diagrams.
        dangerouslySetInnerHTML={{ __html: inline(path.join(images, `${name}.svg`)) }}
      />
      {hasPhone && (
        <div
          className="hidden overflow-x-auto max-sm:block"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the guide's own SVG, drawn by site/scripts/diagrams.
          dangerouslySetInnerHTML={{ __html: inline(phone) }}
        />
      )}
      <figcaption className="px-2 pt-2 pb-1 text-center text-xs text-fd-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
