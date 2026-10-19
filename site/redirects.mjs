// Addresses that moved, so a link in a README, a chat message or a bookmark keeps working.

const CONTRIBUTING = "https://github.com/dip497/hivemind/blob/main/CONTRIBUTING.md";

/** Where an old address now lives, or null when it has not moved. */
export function redirectFor(urlPath) {
  const [path, query] = (urlPath ?? "").split("?");
  const keep = (to) => (query ? `${to}?${query}` : to);
  if (/^\/guide\/contributing\/?$/.test(path)) return CONTRIBUTING;
  // A page has one address, so search engines do not split it in two: /x/index.html is /x/.
  // (/llms.txt and /llms-full.txt used to be sent to /guide; they are files at the root now.)
  // "//host/index.html" is left alone: sent on, it would leave the site.
  if (/^\/(?![/\\])(?:.*\/)?index\.html$/.test(path)) return keep(path.slice(0, -"index.html".length));
  const markdown = /^\/markdown\/([\w-]+)\.md$/.exec(path);
  if (markdown) return keep(markdown[1] === "contributing" ? CONTRIBUTING : `/guide/${markdown[1]}.md`);
  return null;
}
