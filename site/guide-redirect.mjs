// Where an old guide link goes once the guide is served from its own docs site.
//
// The guide's pages keep their names there, so /guide/<page> becomes <docs site>/<page> and a
// link in a README, a chat message or a bookmark keeps working. Nothing moves until
// DOCS_SITE_URL names that site.

/** The docs site a /guide link moves to, from the environment; null leaves the guide here. */
export function docsSiteFrom(env) {
  const url = (env.DOCS_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/]/.test(url) ? url : null;
}

/** The address an old guide path now lives at, or null when the path is not a guide page. */
export function guideRedirectFor(urlPath, docsSite) {
  if (!docsSite) return null;
  const [path, query] = (urlPath ?? "").split("?");
  const m = /^\/guide(?:\/([\w-]+))?\/?$/.exec(path);
  if (!m) return null;
  return `${docsSite}/${m[1] ?? ""}${query ? `?${query}` : ""}`;
}
