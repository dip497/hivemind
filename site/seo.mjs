// What search engines and answer engines read before any page: robots.txt and the sitemap.
// Both are written into dist/ after the build (scripts/seo-files.mjs), from the pages that are
// actually there, so a page added to the site or the guide is listed without anyone editing a list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The site's address, as astro.config.mjs and the guide's lib/shared.ts know it. */
export const SITE_URL = (process.env.SITE_URL || "https://hivemind.griiken.com").replace(/\/$/, "");

/**
 * Crawlers we name so nobody has to guess whether they are welcome: the guide is written to be
 * read by agents (llms.txt, a Markdown copy of every page), and answer engines are how many
 * people meet a developer tool now.
 */
export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  "ClaudeBot", "Claude-SearchBot", "Claude-User",
  "PerplexityBot", "Perplexity-User",
  "Google-Extended", "Applebot-Extended",
];

export function robotsTxt(site = SITE_URL) {
  return [
    "# Every page here is public. The guide is also served as Markdown for agents: /llms.txt",
    "User-agent: *",
    "Allow: /",
    "",
    ...AI_CRAWLERS.map((bot) => `User-agent: ${bot}`),
    "Allow: /",
    "",
    `Sitemap: ${site}/sitemap.xml`,
    "",
  ].join("\n");
}

const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export function sitemapXml(paths, site = SITE_URL) {
  const urls = [...new Set(paths)].sort().map((p) => `  <url><loc>${escapeXml(`${site}${p}`)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** The address a built file is served at, the one its canonical link names: dir/index.html → /dir/. */
export function addressOf(file) {
  const path = `/${file.split(sep).join("/")}`;
  return path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path.replace(/\.html$/, "");
}

/**
 * A page belongs in the sitemap unless it is a "not found" page, a page that only sends you on
 * (a meta refresh), a page marked noindex, or a page whose canonical names another address.
 */
export function isListed(address, html, site = SITE_URL) {
  if (/(^|\/)(404|_not-found)(\/|$)/.test(address)) return false;
  if (/<meta[^>]+http-equiv=["']?refresh/i.test(html)) return false;
  if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) return false;
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  const href = canonical && /href=["']([^"']+)["']/i.exec(canonical)?.[1];
  return !href || href === `${site}${address}`;
}

/** Every listed page under a built site directory, as addresses. */
export function listedPages(root, site = SITE_URL) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".html")) {
        const address = addressOf(relative(root, path));
        if (isListed(address, readFileSync(path, "utf8"), site)) found.push(address);
      }
    }
  };
  walk(root);
  return found.sort();
}
