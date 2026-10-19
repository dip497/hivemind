// robots.txt and the sitemap are generated from dist/, so what they say has to follow from the pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressOf, isListed, robotsTxt, sitemapXml } from "./seo.mjs";

const site = "https://hivemind.example";

test("robots.txt welcomes every crawler and names the sitemap", () => {
  const txt = robotsTxt(site);
  assert.match(txt, /^User-agent: \*\nAllow: \/$/m);
  for (const bot of ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) assert.match(txt, new RegExp(`^User-agent: ${bot}$`, "m"));
  assert.doesNotMatch(txt, /Disallow/);
  assert.match(txt, /^Sitemap: https:\/\/hivemind\.example\/sitemap\.xml$/m);
});

test("a built file is listed at the address its canonical link names", () => {
  assert.equal(addressOf("index.html"), "/");
  assert.equal(addressOf("guide/index.html"), "/guide/");
  assert.equal(addressOf("guide/faq/index.html"), "/guide/faq/");
  assert.equal(addressOf("brand/index.html"), "/brand/");
});

test("not-found pages, redirects, noindex pages and duplicates stay out of the sitemap", () => {
  const page = (canonical) => `<html><head><link rel="canonical" href="${canonical}"/></head></html>`;
  assert.equal(isListed("/guide/faq/", page(`${site}/guide/faq/`), site), true);
  assert.equal(isListed("/guide/faq/", "<html></html>", site), true);
  assert.equal(isListed("/404", "<html></html>", site), false);
  assert.equal(isListed("/guide/404", "<html></html>", site), false);
  assert.equal(isListed("/guide/_not-found/", "<html></html>", site), false);
  assert.equal(isListed("/plugins/", '<meta http-equiv="refresh" content="0; url=https://x"/>', site), false);
  assert.equal(isListed("/draft/", '<meta name="robots" content="noindex"/>', site), false);
  assert.equal(isListed("/old/", page(`${site}/new/`), site), false);
});

test("the sitemap lists each address once, in order, escaped", () => {
  const xml = sitemapXml(["/guide/", "/", "/guide/", "/a&b/"], site);
  assert.equal((xml.match(/<url>/g) ?? []).length, 3);
  assert.ok(xml.indexOf(`${site}/</loc>`) < xml.indexOf(`${site}/guide/</loc>`));
  assert.match(xml, /a&amp;b/);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
});
