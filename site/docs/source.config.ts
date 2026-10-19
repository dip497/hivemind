import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { remarkGuide } from './lib/remark-guide';

export const docs = defineDocs({
  dir: '../../guide',
  docs: {
    files: ['**/*.mdx', '!snippets/**'],
    schema: pageSchema.extend({
      sidebarTitle: z.string().optional(),
      mode: z.enum(['wide']).optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    files: ['**/meta.json'],
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkGuide, ...plugins],
    remarkCodeTabOptions: false,
  },
});
