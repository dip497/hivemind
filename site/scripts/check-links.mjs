// Every link and picture on the built site, the guide included, has to lead somewhere: a file in
// dist/, an address server.mjs redirects, and, for a #heading, an element with that id.
//
//   node scripts/check-links.mjs            (after `npm run build`)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { downloadFor } from "../downloads.mjs";
import { redirectFor } from "../redirects.mjs";

const ROOT = new URL("../dist/", import.meta.url).pathname;
if (!existsSync(ROOT)) throw new Error("links: no dist/; run `npm run build` first");

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name.endsWith(".html")) yield path;
  }
}

/** The file an address means, as server.mjs resolves it. */
function fileFor(urlPath) {
  const candidates = urlPath.endsWith("/")
    ? [join(urlPath, "index.html")]
    : [urlPath, `${urlPath}.html`, join(urlPath, "index.html")];
  for (const c of candidates) {
    const file = join(ROOT, c);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

const ids = new Map();
function hasId(file, id) {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file).has(id);
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

const broken = [];
let checked = 0;
for (const page of htmlFiles(ROOT)) {
  const pageUrl = new URL(`/${relative(ROOT, page)}`.replace(/index\.html$/, "").replace(/\.html$/, ""), "https://site.local");
  const html = readFileSync(page, "utf8");
  for (const [, attr, raw] of html.matchAll(/\s(href|src|poster)="([^"]*)"/g)) {
    const value = decode(raw);
    if (!value || /^(?:[a-z]+:|\/\/)/i.test(value)) continue;
    const url = new URL(value, pageUrl);
    if (url.origin !== pageUrl.origin) continue;
    checked++;
    const path = decodeURIComponent(url.pathname);
    if (redirectFor(path) || downloadFor(path) || /^\/download\/?$/.test(path)) continue;
    const file = fileFor(path);
    const at = `${relative(ROOT, page)}: ${attr}="${value}"`;
    if (!file) broken.push(`${at} (no such page or file)`);
    else if (url.hash && file.endsWith(".html") && !hasId(file, decodeURIComponent(url.hash.slice(1)))) {
      broken.push(`${at} (no ${url.hash} on that page)`);
    }
  }
}

if (broken.length) {
  console.error(`links: ${broken.length} broken of ${checked}\n${broken.join("\n")}`);
  process.exit(1);
}
console.log(`links: all ${checked} internal links lead somewhere`);
