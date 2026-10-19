// Addresses that moved, so a link in a README, a chat message or a bookmark keeps working.

const CONTRIBUTING = "https://github.com/dip497/hivemind/blob/main/CONTRIBUTING.md";

/** Where an old address now lives, or null when it has not moved. */
export function redirectFor(urlPath) {
  const [path, query] = (urlPath ?? "").split("?");
  const keep = (to) => (query ? `${to}?${query}` : to);
  if (/^\/guide\/contributing\/?$/.test(path)) return CONTRIBUTING;
  if (path === "/llms.txt" || path === "/llms-full.txt") return keep(`/guide${path}`);
  const markdown = /^\/markdown\/([\w-]+)\.md$/.exec(path);
  if (markdown) return keep(markdown[1] === "contributing" ? CONTRIBUTING : `/guide/${markdown[1]}.md`);
  return null;
}
