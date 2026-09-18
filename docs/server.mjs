// Serves the built site on Cloud Run. Node's own http and fs are enough for static files, so
// the image carries no dependencies to patch and nothing to go stale.
//
// Cloud Run sets PORT; everything else is convention: a directory means its index.html, a
// hashed asset is immutable, and HTML never caches or a deploy stays invisible.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("./dist/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".md": "text/markdown; charset=utf-8", ".webm": "video/webm", ".mp4": "video/mp4", ".map": "application/json",
};

/** Hashed filenames never change content; everything else is re-fetched or checked. */
function cacheFor(path) {
  if (path.startsWith("/_astro/")) return "public, max-age=31536000, immutable";
  if (path.endsWith(".html")) return "public, max-age=0, must-revalidate";
  if (path.startsWith("/shots/")) return "public, max-age=604800";
  return "public, max-age=3600";
}

/** The file a URL means, or null when it escapes the root or does not exist. */
function resolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const candidates = clean.endsWith("/")
    ? [join(clean, "index.html")]
    : [clean, `${clean}.html`, join(clean, "index.html")];
  for (const c of candidates) {
    const file = join(ROOT, c);
    if (!file.startsWith(ROOT)) continue;            // no traversal out of dist/
    if (existsSync(file) && statSync(file).isFile()) return { file, path: c };
  }
  return null;
}

createServer((req, res) => {
  const hit = resolve(req.url ?? "/");
  if (!hit) {
    const notFound = join(ROOT, "404.html");
    const has404 = existsSync(notFound);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    return has404 ? createReadStream(notFound).pipe(res) : res.end("Not found");
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(hit.file)] ?? "application/octet-stream",
    "cache-control": cacheFor(`/${hit.path.replace(/^\/+/, "")}`),
    "x-content-type-options": "nosniff",
  });
  createReadStream(hit.file).pipe(res);
}).listen(PORT, "0.0.0.0", () => console.log(`serving dist/ on ${PORT}`));
