// Writes robots.txt and sitemap.xml into dist/, from the pages the build produced, and puts the
// guide's llms.txt and llms-full.txt at the root too, where agents look for them first.
//
//   node scripts/seo-files.mjs            (after the site and the guide are in dist/)
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { listedPages, robotsTxt, sitemapXml } from "../seo.mjs";

const ROOT = new URL("../dist/", import.meta.url).pathname;
if (!existsSync(`${ROOT}guide/index.html`)) throw new Error("seo: dist/guide is missing; run the guide build first");

for (const name of ["llms.txt", "llms-full.txt"]) copyFileSync(`${ROOT}guide/${name}`, `${ROOT}${name}`);

const pages = listedPages(ROOT);
writeFileSync(`${ROOT}sitemap.xml`, sitemapXml(pages));
writeFileSync(`${ROOT}robots.txt`, robotsTxt());
console.log(`seo: robots.txt, sitemap.xml (${pages.length} pages), llms.txt and llms-full.txt at the root`);
