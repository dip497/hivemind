// Every link on the site, the guide included, leads somewhere: each href, src, poster and srcset,
// each #heading, each page's Markdown copy, each address inside an "Open in ChatGPT/Claude/…"
// link, each llms.txt and sitemap entry, and each redirect, which must land on a real page in one
// hop and never loop.
//
//   node scripts/check-links.mjs                      the built site in dist/ (after `npm run build`)
//   node scripts/check-links.mjs --dist <dir>         another built site
//   node scripts/check-links.mjs --live <base>        the deployed site over HTTP, external links too
//
// Prints one line per problem (page, link, why) and exits 1 when there is any.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { answerFor } from "../routes.mjs";
import { SITE_URL } from "../seo.mjs";

/** Hosts that answer bots with an error whatever the address, so a failure there proves nothing. */
const BLOCKS_BOTS = new Set(["chatgpt.com", "claude.ai", "cursor.com", "scira.ai", "x.com", "twitter.com", "www.linkedin.com"]);
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 10;

const DOCUMENT = /\.(?:html|md|xml|css)$|(?:^|\/)(?:llms(?:-full)?|robots)\.txt$/;
const isDocumentPath = (path) => path.endsWith("/") || DOCUMENT.test(path);

const entities = { "&amp;": "&", "&#x27;": "'", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" };
const decode = (s) => s.replace(/&(?:amp|#x27|#39|quot|lt|gt);/g, (e) => entities[e]);
const trimAddress = (s) => s.replace(/[.,;:]+$/, "");
const ADDRESS = /https?:\/\/[^\s)<>"'`\]]+/g;

/** Each url(…) in CSS, leaving out data: pictures, which may hold url(…) of their own. */
const cssUrls = (css) =>
  [...css.replace(/url\(\s*(?:"data:[^"]*"|'data:[^']*'|data:[^)]*)\s*\)/g, "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
    .map(([, value]) => ({ attr: "url()", value: decode(value) }));

/** Script bodies and comments hold no links; repeated until nothing changes, so no fragment is left. */
function stripScriptsAndComments(html) {
  let prev;
  do {
    prev = html;
    html = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script[^>]*>/gi, "$1").replace(/<!--[\s\S]*?--!?>/g, "");
  } while (html !== prev);
  return html;
}

/** Each link in an HTML page, with the attribute it sits in, and the ids its #anchors can point at. */
function readHtml(html) {
  const links = [];
  const ids = new Set();
  const body = stripScriptsAndComments(html);
  for (const [, tag, attrText] of body.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attrs = {};
    for (const [, name, value] of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[name.toLowerCase()] = decode(value);
    if (attrs.id) ids.add(attrs.id);
    if (tag.toLowerCase() === "a" && attrs.name) ids.add(attrs.name);
    if (/\b(?:preconnect|dns-prefetch)\b/.test((attrs.rel ?? "").toLowerCase())) continue;
    for (const attr of ["href", "src", "poster"]) if (attrs[attr]) links.push({ attr, value: attrs[attr] });
    for (const attr of ["srcset", "imagesrcset"]) {
      for (const part of (attrs[attr] ?? "").split(",")) {
        const value = part.trim().split(/\s+/)[0];
        if (value) links.push({ attr, value });
      }
    }
    if (tag.toLowerCase() === "meta") {
      const refresh = (attrs["http-equiv"] ?? "").toLowerCase() === "refresh" && /url=(.+)$/i.exec(attrs.content ?? "");
      const name = attrs.property ?? attrs.name ?? "";
      if (refresh) links.push({ attr: "refresh", value: refresh[1].trim().replace(/^['"]|['"]$/g, "") });
      else if (/^(?:og:image|og:image:url|og:image:secure_url|og:url|twitter:image)$/.test(name) && attrs.content) links.push({ attr: name, value: attrs.content });
    }
  }
  return { links: [...links, ...cssUrls(body)], ids };
}

/** Links in Markdown and plain text: [text](link), and bare addresses on the site itself. */
function readText(text, isInternal) {
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const links = [];
  for (const [, value] of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push({ attr: "markdown", value });
  for (const [value] of text.matchAll(ADDRESS)) {
    const clean = trimAddress(value);
    if (isInternal(clean)) links.push({ attr: "address", value: clean });
  }
  return links;
}

function linksIn(kind, text, isInternal) {
  if (kind === "html") return readHtml(text).links;
  if (kind === "css") return cssUrls(text);
  if (kind === "xml") return [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, value]) => ({ attr: "loc", value: decode(value) }));
  return readText(text, isInternal);
}

const kindOf = (path, contentType = "") => {
  if (/html/.test(contentType) || path.endsWith("/") || path.endsWith(".html")) return "html";
  if (path.endsWith(".css") || /text\/css/.test(contentType)) return "css";
  if (path.endsWith(".xml") || /xml/.test(contentType)) return "xml";
  return "text";
};

/**
 * Checks a site through `get(url, internal)`, which answers one address as
 * `{ status, location, kind, text }`, or null when it cannot check that address. Starts at
 * `seeds` and follows every link on the site. Returns each problem as { page, link, why }, and
 * each address that redirects with its hops.
 */
export async function checkSite({ get, seeds, site, live = false, log = () => {} }) {
  const origins = new Set([new URL(site).origin, ...seeds.map((s) => new URL(s).origin)]);
  const isInternal = (href) => {
    try { return origins.has(new URL(href).origin); } catch { return false; }
  };
  const display = (url) => (isInternal(url.href) ? `${url.pathname}${url.search}` : url.href);
  const blocksBots = (url) => !isInternal(url.href) && BLOCKS_BOTS.has(url.host);

  const problems = [];
  const said = new Set();
  const say = (page, link, why) => {
    const key = `${page}\0${link}\0${why}`;
    if (!said.has(key)) { said.add(key); problems.push({ page, link, why }); }
  };

  const texts = new Map();
  const textOf = (url, res) => {
    if (!texts.has(url.href)) texts.set(url.href, res.text());
    return texts.get(url.href);
  };
  const idSets = new Map();
  const idsOf = (url, res) => {
    if (!idSets.has(url.href)) idSets.set(url.href, textOf(url, res).then((html) => readHtml(html).ids));
    return idSets.get(url.href);
  };

  /** Where an address ends, through every redirect and meta refresh. */
  const answers = new Map();
  const follow = (url) => {
    if (!answers.has(url.href)) answers.set(url.href, (async () => {
      const hops = [];
      const visited = new Set();
      let current = url;
      for (let i = 0; i <= MAX_HOPS; i++) {
        if (visited.has(current.href)) return { hops, loop: true };
        visited.add(current.href);
        let res;
        try {
          res = await get(current, isInternal(current.href));
        } catch (error) {
          return { hops, url: current, error: error.cause?.code ?? error.name ?? String(error) };
        }
        if (!res) return { hops, url: current, unchecked: true };
        let to = res.status >= 300 && res.status < 400 && res.location ? res.location : null;
        let how = String(res.status);
        if (!to && res.status === 200 && res.kind === "html" && isInternal(current.href)) {
          to = readHtml(await textOf(current, res)).links.find((l) => l.attr === "refresh")?.value;
          how = "refresh";
        }
        if (!to) return { hops, url: current, res };
        const next = new URL(to, current);
        hops.push({ from: current, how, to: next });
        current = next;
      }
      return { hops, tooMany: true };
    })());
    return answers.get(url.href);
  };

  const redirects = new Map();
  const queued = new Set();
  const queue = [];
  const enqueue = (url) => {
    if (!queued.has(url.href)) { queued.add(url.href); queue.push(url); }
  };
  for (const seed of seeds) enqueue(new URL(seed));

  const checkLink = async (page, link, base) => {
    const raw = link.value.trim();
    if (!raw || raw === "#" || /^(?:mailto|tel|javascript|data|blob|about):/i.test(raw) || /[{}]/.test(raw)) return;
    let url;
    try {
      url = new URL(raw, base);
    } catch {
      return say(page, raw, "not a valid address");
    }
    if (!/^https?:$/.test(url.protocol)) return;
    // An "Open in …" link carries a page's address in its query: that address has to work too.
    if (!isInternal(url.href)) {
      for (const value of url.searchParams.values()) {
        for (const [inner] of value.matchAll(ADDRESS)) {
          const clean = trimAddress(inner);
          if (isInternal(clean)) await checkLink(page, { attr: link.attr, value: clean, inside: url.host }, base);
        }
      }
    }
    const label = link.inside ? `${raw} (inside the ${link.inside} link)` : raw;
    const target = new URL(url.href);
    target.hash = "";
    const end = await follow(target);
    if (end.hops.length) redirects.set(target.href, end);
    const trail = () => [display(target), ...end.hops.map((h) => `${h.how} ${display(h.to)}`)].join(" → ");
    if (end.loop) return say(page, label, `redirect loop: ${trail()}`);
    if (end.tooMany) return say(page, label, `more than ${MAX_HOPS} redirects: ${trail()}`);
    const internalHops = end.hops.filter((h) => isInternal(h.from.href) && isInternal(h.to.href));
    if (internalHops.length > 1) say(page, label, `redirect chain of ${internalHops.length} hops: ${trail()}`);
    else if (internalHops.length === 1 && internalHops[0].to.pathname === `${target.pathname}/`) {
      say(page, label, `leads through a redirect to ${display(internalHops[0].to)}; link there`);
    }
    if (end.unchecked) return;
    if (end.error) {
      if (!blocksBots(end.url)) say(page, label, `${end.hops.length ? `${trail()}: ` : ""}no answer (${end.error})`);
      return;
    }
    if (end.res.status !== 200) {
      if (blocksBots(end.url)) return;
      const why = end.res.status === 404 ? "no such page or file (404)" : `answers ${end.res.status}`;
      return say(page, label, end.hops.length ? `${trail()}: ${why}` : why);
    }
    if (!isInternal(end.url.href)) return;
    if (isDocumentPath(end.url.pathname) || end.res.kind === "html") enqueue(end.url);
    if (url.hash.length > 1 && end.res.kind === "html") {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!(await idsOf(end.url, end.res)).has(id)) say(page, label, `no ${url.hash} on ${display(end.url)}`);
    }
  };

  let checked = 0;
  while (queue.length) {
    const url = queue.shift();
    const end = await follow(url);
    if (end.hops.length) continue; // its links are read where it lands
    if (!end.res || end.res.status !== 200) {
      say(display(url), display(url), end.res ? `answers ${end.res.status}` : `no answer (${end.error ?? "unchecked"})`);
      continue;
    }
    const page = display(url);
    const links = linksIn(end.res.kind, await textOf(url, end.res), isInternal);
    const pending = [];
    for (const link of links) {
      checked++;
      pending.push(checkLink(page, link, url));
      if (pending.length >= (live ? 8 : 64)) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
    log(`read ${page} (${links.length} links)`);
  }
  return { problems, redirects, checked, pages: queued.size };
}

/** Answers addresses from a built site on disk, the way server.mjs serves it. */
export function builtSite(root) {
  return async (url, internal) => {
    if (!internal) return null;
    const answer = answerFor(`${url.pathname}${url.search}`, root);
    if (!answer) return { status: 404, kind: "none" };
    if (answer.location) return { status: answer.status, location: answer.location };
    return { status: 200, kind: kindOf(answer.path), text: async () => readFileSync(answer.file, "utf8") };
  };
}

/** Every page and text file of a built site, as addresses on `site`. */
export function builtSeeds(root, site) {
  const seeds = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "_next" && name !== "_astro") walk(path);
        continue;
      }
      const rel = `/${relative(root, path).split("\\").join("/")}`;
      if (rel.endsWith("/index.html")) seeds.push(rel.slice(0, -"index.html".length));
      else if (rel.endsWith(".html")) seeds.push(rel.slice(0, -".html".length));
      else if (DOCUMENT.test(rel)) seeds.push(rel);
    }
  };
  walk(root);
  return seeds.sort().map((p) => new URL(p, site).href);
}

/** Answers addresses over HTTP. An address on the canonical site is asked of `base` instead. */
export function liveSite(base, site) {
  const baseUrl = new URL(base);
  const siteOrigin = new URL(site).origin;
  const headers = { "user-agent": "Mozilla/5.0 (compatible; hivemind-check-links; +https://github.com/dip497/hivemind)" };
  return async (url, internal) => {
    const target = new URL(url.href);
    if (internal && target.origin === siteOrigin) Object.assign(target, { protocol: baseUrl.protocol, host: baseUrl.host });
    const ask = (method) => fetch(target, { method, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const document = internal && isDocumentPath(target.pathname);
    let res = document ? await ask("GET") : await ask("HEAD").catch(() => null);
    if (!res || (!document && res.status >= 400)) {
      await res?.body?.cancel();
      res = await ask("GET");
    }
    if (res.status === 429) {
      await res.body?.cancel();
      const wait = Math.min(Number(res.headers.get("retry-after")) || 5, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await ask("GET");
    }
    const kind = kindOf(target.pathname, res.headers.get("content-type") ?? "");
    const body = internal && res.status === 200 && (document || kind === "html") ? res.text() : null;
    if (!body) await res.body?.cancel();
    return { status: res.status, location: res.headers.get("location"), kind, text: () => body ?? Promise.resolve("") };
  };
}

function parseArgs(argv) {
  const args = { dist: new URL("../dist/", import.meta.url).pathname, site: SITE_URL, live: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dist") args.dist = resolve(argv[++i]);
    else if (arg === "--site") args.site = argv[++i];
    else if (arg === "--live") args.live = argv[++i];
    else if (arg === "--verbose") args.verbose = true;
    else throw new Error(`links: unknown argument ${arg}; use --dist <dir>, --live <base>, --site <url> or --verbose`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = args.site.replace(/\/$/, "");
  const log = args.verbose ? (line) => console.error(line) : undefined;
  let result;
  if (args.live) {
    const base = args.live.replace(/\/$/, "");
    const seeds = ["/", "/guide/", "/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/guide/llms.txt", "/guide/llms-full.txt"]
      .map((p) => `${base}${p}`);
    result = await checkSite({ get: liveSite(base, site), seeds, site, live: true, log });
    for (const [from, end] of [...result.redirects].sort(([a], [b]) => a.localeCompare(b))) {
      const final = end.res?.status ?? (end.loop ? "loop" : end.error ?? "not checked");
      console.log(`redirect: ${from} ${end.hops.map((h) => `→ ${h.how} ${h.to.href}`).join(" ")} → ${final}`);
    }
  } else {
    if (!existsSync(args.dist)) throw new Error(`links: no ${args.dist}; run \`npm run build\` first`);
    result = await checkSite({ get: builtSite(args.dist), seeds: builtSeeds(args.dist, site), site, log });
  }
  const { problems, checked, pages } = result;
  for (const p of problems) console.log(`${p.page}: ${p.link}: ${p.why}`);
  const summary = `links: ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${checked} links on ${pages} pages and files`;
  if (problems.length) {
    console.error(summary);
    process.exit(1);
  }
  console.log(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
