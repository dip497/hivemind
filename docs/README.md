# Website and documentation

Astro + Starlight, built as static HTML. Guides live in `src/content/docs/guide/`.
The build also exports `/llms.txt`, `/llms-full.txt`, and `/markdown/*.md` from the
same content. Historical architecture notes remain in `design/`.

## Local development

Requires Node 22.19 or newer.

```sh
cd docs
npm ci
npm run dev
npm run build
```

The default base path is `/hivemind`, for GitHub Pages. For hosting at a domain root:

```sh
SITE_BASE=/ SITE_URL=https://example.com npm run build
```

GitHub Actions builds `docs/dist` on changes merged to `main`.
Do not deploy this project through ChatGPT Sites.

## Writing

Keep titles short. Start with the action or behavior. Include commands people can
run, prerequisites, and actual limitations. Avoid taglines and repeated introductions.
Mark unreleased features as development previews. Verify command examples against
`apps/cli/src/commands/` and SDK examples against `packages/hive-view-sdk/src/`.

Use relative links to sibling guides (`../agents/`). The build resolves these to
absolute URLs in the Markdown exports. Do not copy documentation into a second
agent-only version.
