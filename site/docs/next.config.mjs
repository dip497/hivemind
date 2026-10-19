import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/guide',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  // The pages live in guide/ at the top of the repository, outside this app.
  turbopack: { root: path.resolve(here, '../..') },
  outputFileTracingRoot: path.resolve(here, '../..'),
};

export default createMDX()(config);
