import { docs } from 'collections/server';
import { type InferPageType, loader } from 'fumadocs-core/source';
import type * as PageTree from 'fumadocs-core/page-tree';
import { absoluteLinks, appName, docsUrl, pageAddress, pageMarkdownAddress } from './shared';

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [
      {
        // A page may name itself differently in the sidebar, as "Introduction" for the home page.
        file(node, filePath) {
          const file = filePath ? this.storage.read(filePath) : undefined;
          if (file?.format === 'page') {
            const sidebarTitle = (file.data as { sidebarTitle?: string }).sidebarTitle;
            if (sidebarTitle) node.name = sidebarTitle;
          }
          return node;
        },
      },
    ],
  },
});

export type GuidePage = InferPageType<typeof source>;

/** A diagram as a picture link: the list under it in the page carries the same facts as text. */
const diagramsAsLinks = (markdown: string) =>
  markdown.replace(
    /<Diagram\s+name="([a-z0-9-]+)"\s+caption="([^"]*)"\s*\/>/g,
    (_all, name: string, caption: string) => `![Diagram: ${caption}](${docsUrl}/images/${name}.svg)`,
  );

/** One page as Markdown, with every link a full address so it reads the same anywhere. */
export async function pageMarkdown(page: GuidePage) {
  const body = absoluteLinks(diagramsAsLinks(await page.data.getText('processed')));
  return `# ${page.data.title}\n\n> ${page.data.description}\n\nSource: ${pageAddress(page.url)}\n\n${body.trim()}\n`;
}

/** llms.txt: every page with its one-line description, grouped as the sidebar groups them. */
export function llmsIndex() {
  const lines = [
    `# ${appName}`,
    '',
    '> A workspace your coding agents build and work in: run them side by side, add your own views, widgets and tools, and drive it all from other computers, your phone or your own program.',
    '',
    `Every page is also Markdown: add .md to its address. All of them in one file: ${docsUrl}/llms-full.txt`,
  ];
  const visit = (nodes: PageTree.Node[], depth: number) => {
    for (const node of nodes) {
      if (node.type === 'separator') {
        lines.push('', `${'#'.repeat(depth)} ${node.name}`, '');
      } else if (node.type === 'folder') {
        lines.push('', `${'#'.repeat(depth)} ${node.name}`, '');
        if (node.index) visit([node.index], depth + 1);
        visit(node.children, depth + 1);
      } else {
        const page = source.getNodePage(node);
        if (page) lines.push(`- [${page.data.title}](${pageMarkdownAddress(page.slugs)}): ${page.data.description}`);
      }
    }
  };
  visit(source.getPageTree().children, 2);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** llms-full.txt: every page in sidebar order, in one file. */
export async function llmsFull() {
  const pages = await Promise.all(source.getPages().map(pageMarkdown));
  return pages.join('\n---\n\n');
}
