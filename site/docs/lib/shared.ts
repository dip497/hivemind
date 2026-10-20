export const appName = 'Hivemind';

/** Where the guide is served on the website. */
export const basePath = '/guide';
export const siteUrl = 'https://hivemind.griiken.com';
export const docsUrl = `${siteUrl}${basePath}`;

/** The release the pages were last checked against. */
export const validatedFor = '2026.10.3';

export const repoUrl = 'https://github.com/dip497/hivemind';
export const downloadUrl = `${siteUrl}/download`;

/** The picture a link to any guide page shows when it is shared: the website's own card. */
export const ogImage = `${siteUrl}/shots/og.jpg`;
export const cardAlt = `${appName}: your agents build the workspace they work in`;

/**
 * A guide page's one address, in full, with the trailing slash the export gives every page.
 * Metadata takes full addresses only: Next joins a path that starts with / onto metadataBase's
 * path, so "/guide/x.md" became "/guide/guide/x.md".
 */
export function pageAddress(url: string) {
  return `${docsUrl}${url.endsWith('/') ? url : `${url}/`}`;
}

/** A page's source file on GitHub, from its path inside guide/. */
export function sourceUrl(path: string, action: 'blob' | 'edit' = 'blob') {
  return `${repoUrl}/${action}/main/guide/${path}`;
}

/** The address of a page as Markdown, next to its HTML page: /guide/machines.md. */
export function pageMarkdownPath(slugs: string[]) {
  return `${basePath}/${slugs.length === 0 ? 'index' : slugs.join('/')}.md`;
}

/** A page's Markdown copy in full, for anything read off the site: an agent, a search engine. */
export function pageMarkdownAddress(slugs: string[]) {
  return `${siteUrl}${pageMarkdownPath(slugs)}`;
}

/** Turns the guide's root-relative links and pictures into full addresses, for text read elsewhere. */
export function absoluteLinks(markdown: string) {
  const inGuide = `${basePath.slice(1)}/`;
  return markdown.replace(
    /(\]\(|(?:href|src|poster|img)=")\/(?!\/)([^\s)"#?]*)/g,
    (_all, lead: string, path: string) => {
      // A page's address ends in a slash; without it the reader takes a redirect first.
      const page = path && !path.endsWith('/') && !/\.\w+$/.test(path) ? `${path}/` : path;
      return page.startsWith(inGuide) ? `${lead}${siteUrl}/${page}` : `${lead}${docsUrl}/${page}`;
    },
  );
}
