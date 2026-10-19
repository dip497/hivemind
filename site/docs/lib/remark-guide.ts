import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { basePath } from './shared';

const ASSET_ATTRIBUTES = new Set(['src', 'poster', 'img']);

/**
 * The guide's own conventions: "```bash Linux and macOS" names the block, and a picture's
 * address starts at the guide's root, which is served under the base path.
 */
export function remarkGuide() {
  return (tree: Root) => {
    visit(tree, 'code', (node) => {
      if (node.meta && !node.meta.includes('=')) node.meta = `title=${JSON.stringify(node.meta.trim())}`;
    });
    visit(tree, ['mdxJsxFlowElement', 'mdxJsxTextElement'], (node) => {
      if (!('attributes' in node)) return;
      for (const attribute of node.attributes) {
        if (attribute.type !== 'mdxJsxAttribute' || !ASSET_ATTRIBUTES.has(attribute.name)) continue;
        if (typeof attribute.value === 'string' && attribute.value.startsWith('/images/')) {
          attribute.value = `${basePath}${attribute.value}`;
        }
      }
    });
  };
}
