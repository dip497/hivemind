// Every page on the built site, the guide included, has what a search engine or an answer engine
// needs to list it: a title, a description, one h1, a canonical link naming its own address, and
// structured data that parses. robots.txt, the sitemap and llms.txt are where they should be.
//
//   node scripts/check-seo.mjs            (after `npm run build`)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SITE_URL, addressOf } from "../seo.mjs";

const ROOT = new URL("../dist/", import.meta.url).pathname;
if (!existsSync(ROOT)) throw new Error("seo: no dist/; run `npm run build` first");

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name.endsWith(".html")) yield path;
  }
}

const problems = [];
// A canonical link or a description outside <head> is ignored by search engines, so look there only.
const head = (html) => { const end = html.indexOf("</head>"); return end < 0 ? html : html.slice(0, end); };
let pages = 0;
for (const file of htmlFiles(ROOT)) {
  const address = addressOf(relative(ROOT, file));
  const html = readFileSync(file, "utf8");
  if (/(^|\/)(404|_not-found)(\/|$)/.test(address) || /http-equiv=["']?refresh/i.test(html)) continue;
  pages++;
  const say = (what) => problems.push(`${address}: ${what}`);
  const top = head(html);
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(top)?.[1].trim();
  if (!title) say("no <title>");
  if (!/<meta[^>]+name="description"[^>]+content="[^"]{20,}"/i.test(top)) say("no meta description of 20 characters or more");
  const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(top)?.[1];
  if (!canonical) say("no canonical link");
  else if (canonical !== `${SITE_URL}${address}`) say(`canonical is ${canonical}, not ${SITE_URL}${address}`);
  const h1s = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (h1s !== 1) say(`${h1s} <h1> elements, not 1`);
  if (top.includes("/guide/guide/")) say("an address in <head> repeats /guide/");
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(json); } catch (e) { say(`structured data does not parse: ${e.message}`); }
  }
}

const sitemap = existsSync(`${ROOT}sitemap.xml`) ? readFileSync(`${ROOT}sitemap.xml`, "utf8") : "";
if (!sitemap) problems.push("dist/sitemap.xml is missing");
const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
for (const loc of listed) {
  const path = loc.startsWith(SITE_URL) ? loc.slice(SITE_URL.length) : null;
  if (!path || !existsSync(join(ROOT, path.endsWith("/") ? `${path}index.html` : `${path}.html`))) problems.push(`sitemap lists ${loc}, which is not a page`);
}
if (listed.length < pages) problems.push(`sitemap lists ${listed.length} pages of ${pages}`);
const robots = existsSync(`${ROOT}robots.txt`) ? readFileSync(`${ROOT}robots.txt`, "utf8") : "";
if (!robots.includes(`Sitemap: ${SITE_URL}/sitemap.xml`)) problems.push("robots.txt is missing or does not name the sitemap");
if (/^Disallow:\s*\/\s*$/m.test(robots)) problems.push("robots.txt shuts crawlers out");
for (const name of ["llms.txt", "llms-full.txt"]) if (!existsSync(`${ROOT}${name}`)) problems.push(`dist/${name} is missing`);

if (problems.length) {
  console.error(`seo: ${problems.length} problem(s) on ${pages} pages:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`seo: ${pages} pages with a title, a description, one h1 and their own canonical; ${listed.length} in the sitemap`);
