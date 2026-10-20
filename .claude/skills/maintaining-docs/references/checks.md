# Checks before a docs PR

Run these one at a time. On a busy machine, run each under `nice -n 10`. Kill only processes you
started.

```bash
cd site && npm ci && npm ci --prefix docs     # once
npm run diagrams                               # only if a diagram changed
npm run build                                  # the site and the guide; a page that does not compile fails it
node scripts/check-links.mjs                   # every link, anchor, .md copy and redirect leads somewhere
```

`check-links` prints one line per problem, `page: link: why`, and exits 1 when there is any. It
reads every page, `.md` copy, `llms.txt`, `robots.txt` and the sitemap, and the links in each,
including the addresses inside an **Open in ChatGPT/Claude/…** link. A redirect must land on a
real page in one hop. After a deploy, check the real site, its external links included:

```bash
node scripts/check-links.mjs --live https://hivemind.griiken.com
```

It prints each redirect with its hops and final status, then the problems. A few sites answer
every bot with an error (ChatGPT, Claude, Cursor); a failure there is not reported.

`npm run guide` rebuilds only the guide, and is faster when only `guide/` changed. CI runs the
build and the link check too, but run them first: a red PR wastes a review.

## Geometry

```bash
git clone --depth 1 https://github.com/cathrynlavery/diagram-design <scratch>/diagram-design
python3 -I <scratch>/diagram-design/scripts/verify-geometry.py guide/images/*.svg
```

The result must be `0 finding(s)`. Clone it outside the repo, in your scratch folder, and run it
with `-I`.

## Screenshots

Serve the built site and shoot every page you changed at 1440×900 and 390×844, light and dark:

```bash
cd site/dist && python3 -m http.server 4719 --bind 127.0.0.1 &   # note its PID; kill only that
```

```js
// Run with node; playwright is in site/node_modules.
import { chromium } from './site/node_modules/playwright/index.mjs';
const b = await chromium.launch();
for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844]]) {
  const p = await (await b.newContext({ viewport: { width, height }, colorScheme })).newPage();
  for (const name of ['architecture' /* the pages you changed */]) {
    await p.goto(`http://127.0.0.1:4719/guide/${name}/`, { waitUntil: 'networkidle' });
    await p.locator('figure.guide-diagram').first().scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: `<scratch>/${name}-${width}-${colorScheme}.png` });
  }
}
await b.close();
```

Look at every shot. Check that:

- the diagram text is readable and the page does not scroll sideways at 390;
- no grey text is hard to read in dark mode;
- the list under each diagram matches it;
- code blocks, tables and prompts fit or scroll inside their own box.

## Merging

Merging to `main` deploys the site: `.github/workflows/site.yml` runs on changes under `site/**`
and `guide/**`. Open the PR and leave the merge to the maintainer unless you were told to merge.
