export const appName = 'Hivemind';

/** Where the guide is served on the website. */
export const basePath = '/guide';
export const siteUrl = 'https://hivemind.griiken.com';
export const docsUrl = `${siteUrl}${basePath}`;

/** The release the pages were last checked against. */
export const validatedFor = '2026.10.3';

export const repoUrl = 'https://github.com/dip497/hivemind';
export const downloadUrl = `${siteUrl}/download`;

/** A page's source file on GitHub, from its path inside guide/. */
export function sourceUrl(path: string, action: 'blob' | 'edit' = 'blob') {
  return `${repoUrl}/${action}/main/guide/${path}`;
}

/** The address of a page as Markdown, next to its HTML page: /guide/machines.md. */
export function pageMarkdownPath(slugs: string[]) {
  return `${basePath}/${slugs.length === 0 ? 'index' : slugs.join('/')}.md`;
}

/** Turns the guide's root-relative links and pictures into full addresses, for text read elsewhere. */
export function absoluteLinks(markdown: string) {
  const inGuide = `${basePath.slice(1)}/`;
  return markdown.replace(
    /(\]\(|(?:href|src|poster|img)=")\/(?!\/)(\S*)/g,
    (_all, lead: string, rest: string) =>
      rest.startsWith(inGuide) ? `${lead}${siteUrl}/${rest}` : `${lead}${docsUrl}/${rest}`,
  );
}
