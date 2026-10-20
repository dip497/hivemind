# Website and guide

The website (https://hivemind.griiken.com/) is Astro, built as static HTML. Its guide, at `/guide`, is a
separate app in `docs/`: [Fumadocs](https://www.fumadocs.dev) on Next.js, exported as static
files. The guide's pages live outside `site/`, in `guide/` at the top of the repository; see
`guide/AGENTS.md` for how to write them.

`npm run build` builds the site into `dist/`, then the guide into `docs/out/`, and copies that to
`dist/guide`. The guide also serves `/guide/llms.txt`, `/guide/llms-full.txt` and every page as
Markdown (`/guide/<page>.md`). Last, `scripts/seo-files.mjs` writes `robots.txt` and a
`sitemap.xml` of every built page into `dist/`, and copies both `llms` files to the root.

## Local development

Requires Node 22.19 or newer.

```sh
cd site
npm ci && npm ci --prefix docs
npm run dev                         # the site, without the guide
npm run guide:dev                   # the guide alone, at http://localhost:3000/guide/
npm run build                       # both, into dist/
node scripts/check-links.mjs        # every link, anchor, .md copy and redirect in dist/ leads somewhere
node scripts/check-links.mjs --live https://hivemind.griiken.com   # the same on the deployed site, external links too
node scripts/check-seo.mjs          # every page has a title, description, one h1, its own canonical
PORT=8080 node server.mjs           # serve dist/ as Cloud Run does
```

`.github/workflows/site.yml` builds `dist/` and deploys it to Cloud Run when a change under
`site/` or `guide/` reaches `main`; the container only carries `dist/` and `server.mjs`.
`redirects.mjs` keeps old addresses working. Do not deploy this project through ChatGPT Sites.
