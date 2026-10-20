// What the site answers for an address: a redirect, a file in dist/, or nothing (404).
// server.mjs serves it and scripts/check-links.mjs checks links against it, so both agree.
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { downloadFor } from "./downloads.mjs";
import { redirectFor } from "./redirects.mjs";

/** The file a path means under root, or null when it escapes the root or does not exist. */
function resolve(path, root) {
  let clean;
  try {
    clean = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  } catch {
    return null;
  }
  const candidates = clean.endsWith("/")
    ? [join(clean, "index.html")]
    : [clean, `${clean}.html`, join(clean, "index.html")];
  for (const c of candidates) {
    const file = join(root, c);
    if (!file.startsWith(root)) continue;            // no traversal out of dist/
    // A directory's page asked for without its slash: the page's address ends in one.
    const slashless = !clean.endsWith("/") && c.endsWith("index.html") && !clean.endsWith("index.html");
    if (existsSync(file) && statSync(file).isFile()) return { file, path: c, clean, slashless };
  }
  return null;
}

/**
 * What a request for `url` (path and query) gets: `{ status, location, cache }` for a redirect,
 * `{ file, path }` for a file, or null when there is nothing there.
 */
export function answerFor(url, root) {
  const [path, query] = (url || "/").split("?");
  // /download is the short URL people share; the section that downloads it lives on the home page.
  if (/^\/download\/?$/.test(path)) return { status: 302, location: "/#download", cache: "public, max-age=300" };
  const moved = redirectFor(url);
  if (moved) return { status: 301, location: moved, cache: "public, max-age=86400" };
  // A download link is sent on to the current release, so it never names a version.
  const download = downloadFor(url);
  if (download) return { status: 302, location: download, cache: "public, max-age=300" };
  const hit = resolve(path, root);
  if (!hit) return null;
  if (hit.slashless) {
    // /guide/faq and /guide/faq/ are one page; search engines should only ever see the second.
    // Built from the normalized path, never the raw one: "//host" must not become a redirect off-site.
    const location = `${encodeURI(hit.clean)}/${query !== undefined ? `?${query}` : ""}`;
    return { status: 301, location, cache: "public, max-age=86400" };
  }
  return { file: hit.file, path: hit.path };
}
