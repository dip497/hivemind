// Serves the built site on Cloud Run. Node's own http and fs are enough for static files, so
// the image carries no dependencies to patch and nothing to go stale.
//
// Cloud Run sets PORT; everything else is convention: a directory means its index.html, a
// hashed asset is immutable, and HTML never caches or a deploy stays invisible.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { rangeFor } from "./byte-range.mjs";
import { answerFor } from "./routes.mjs";

const ROOT = new URL("./dist/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".avif": "image/avif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".md": "text/markdown; charset=utf-8",
  // The installers are served to be read as much as piped: a browser shows them as text.
  ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8", ".webm": "video/webm", ".mp4": "video/mp4", ".map": "application/json",
};

/** Text goes out compressed when the browser can read it; images and video already are. */
const TEXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".xml", ".md", ".map"]);
function encoderFor(req, file) {
  if (!TEXT.has(extname(file))) return null;
  const accept = String(req.headers["accept-encoding"] ?? "");
  if (/\bbr\b/.test(accept)) return ["br", () => createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })];
  if (/\bgzip\b/.test(accept)) return ["gzip", () => createGzip()];
  return null;
}

/** Hashed filenames never change content; everything else is re-fetched or checked. */
function cacheFor(path) {
  if (path.startsWith("/_astro/") || path.startsWith("/guide/_next/static/")) return "public, max-age=31536000, immutable";
  if (path.endsWith(".html")) return "public, max-age=0, must-revalidate";
  if (path.startsWith("/shots/")) return "public, max-age=604800";
  return "public, max-age=3600";
}

/** Where a redirect may send a browser: a path on this site, or this project on GitHub. */
const PROJECT = "https://github.com/dip497/hivemind/";
const stays = (location) => (location.startsWith("/") && !/^\/[/\\]/.test(location)) || location.startsWith(PROJECT);

createServer((req, res) => {
  const found = answerFor(req.url ?? "/", ROOT);
  const hit = found?.location && !stays(found.location) ? null : found;
  if (hit?.location) {
    res.writeHead(hit.status, { location: hit.location, "cache-control": hit.cache });
    return res.end();
  }
  if (!hit) {
    // The guide has its own page for a missing page, with its sidebar and search.
    const inGuide = /^\/guide(\/|$)/.test(req.url ?? "");
    const notFound = join(ROOT, inGuide ? "guide/404.html" : "404.html");
    const has404 = existsSync(notFound);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    return has404 ? createReadStream(notFound).pipe(res) : res.end("Not found");
  }
  const encoder = encoderFor(req, hit.file);
  const headers = {
    "content-type": TYPES[extname(hit.file)] ?? "application/octet-stream",
    "cache-control": cacheFor(`/${hit.path.replace(/^\/+/, "")}`),
    "x-content-type-options": "nosniff",
    vary: "accept-encoding",
  };
  if (encoder) {
    res.writeHead(200, { ...headers, "content-encoding": encoder[0] });
    if (req.method === "HEAD") return res.end();
    return createReadStream(hit.file).pipe(encoder[1]()).pipe(res);
  }
  const size = statSync(hit.file).size;
  const range = rangeFor(req.headers.range, size);
  if (range === false) {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
    return res.end();
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD" || size === 0) return res.end();
  createReadStream(hit.file, { start, end }).pipe(res);
}).listen(PORT, "0.0.0.0", () => console.log(`serving dist/ on ${PORT}`));
