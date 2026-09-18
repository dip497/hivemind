# Deploying the two sites on AWS

Status: plan, 2026-09-17. Targets `hivemind.griiken.com` (the site + docs) and
`hivehub.griiken.com` (the plugin registry).

## The question that decides everything: static or SSR?

They are not the same kind of application, and the guide's Lambda recipe is only
needed by one of them.

| | Hivemind site + docs | HiveHub |
|---|---|---|
| Repo / dir | `hivemind/docs` | `hivehub` (separate repo) |
| Astro output | **static** (no adapter in `astro.config.mjs`) | **`output: "server"`** with `@astrojs/cloudflare` |
| What a build emits | 36 HTML files + assets | `dist/client` assets **and** `dist/_worker.js` |
| Server code at runtime | none | every page, plus `/api/v1/*`, `/auth/*`, `/publish` |
| Database | none | Cloudflare **D1** (SQLite), binding `DB` |
| Secrets | none | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `COUNT_SECRET` |
| Writes | none | publish, install counts, sessions |

So: **the docs site needs no Lambda, no container and no database.** It is files.
Putting it behind a Lambda would add cold starts and cost for nothing.
**HiveHub is the one that needs compute and storage.**

## Site + docs — S3 + CloudFront

```
users → hivemind.griiken.com → CloudFront → S3 (private, OAI/OAC) → HTML + assets
```

Free tier covers it, there is nothing to keep warm, and a deploy is a sync plus an
invalidation.

Two things must change in the repo before the first deploy:

1. **The base path.** The site is currently built for GitHub Pages under
   `/hivemind` (`SITE_BASE`, default `/hivemind`). On its own domain it serves
   from the root, so the build must run with `SITE_BASE='' SITE_URL=https://hivemind.griiken.com`.
   Every internal link, the sitemap, the OG tags and the `llms.txt` link derive
   from those two, so getting it wrong breaks every link on the site rather than
   one page.
2. **Pick one publisher.** `.github/workflows/pages.yml` currently deploys to
   GitHub Pages. Either retire it or keep it as the staging copy; two publishers
   for one site is how a stale build ends up on the domain nobody checks.

Deploy is:

```bash
cd docs && SITE_BASE='' SITE_URL=https://hivemind.griiken.com npm run build
aws s3 sync dist/ s3://hivemind-site --delete \
  --cache-control "public,max-age=31536000,immutable" --exclude "*.html"
aws s3 sync dist/ s3://hivemind-site --delete \
  --cache-control "public,max-age=0,must-revalidate" --exclude "*" --include "*.html"
aws cloudfront create-invalidation --distribution-id $DIST --paths "/*"
```

Two syncs on purpose: hashed assets are immutable and should stick at the edge;
HTML must not, or a deploy is invisible until the TTL expires.

## HiveHub — Lambda container + CloudFront, and a data decision

```
users → hivehub.griiken.com → CloudFront ─┬─ /_astro/*, /art/* → S3 (static assets)
                                          └─ everything else   → Lambda Function URL
                                                                    │
                                                                    └─ database
```

Serving the assets from S3 rather than Lambda is worth the extra origin: they are
the bulk of the traffic and none of it should wake a function.

### The blocker: it is written against D1

`src/lib/db.ts` is typed `D1Database` and every query is
`db.prepare(sql).bind(...).first()/all()/run()`. That API comes from the
Cloudflare runtime; on Lambda it does not exist. Three ways out:

1. **Turso / libSQL (recommended).** SQLite-compatible, HTTP driver, free tier.
   The migration is a ~40-line shim exposing `prepare().bind().first()/all()/run()`
   over libSQL, and `migrations/0000_init.sql` applies unchanged — it is the same
   dialect. `src/lib/*.ts` keeps its raw SQL. Sessions and counts keep working as
   written.
2. **Stay on Cloudflare for HiveHub.** Workers + D1 is what it was built for, it
   is also free, and then AWS only serves the docs site. Least work by a distance;
   the cost is two platforms.
3. **DynamoDB.** Inside AWS's free tier, but every query in `db.ts`, `registry.ts`
   and `counts.ts` is SQL with joins (`plugins` ⋈ `users` for the verified
   publisher) and an `ORDER BY installs`. That is a rewrite, not a port.

Recommendation: **(1) for one platform, (2) if the goal is shipping this week.**
Either way the decision is data, not hosting — that is what "does publish need
storage" comes down to.

### Other things that must change before it runs on Lambda

- **Adapter.** `@astrojs/cloudflare` → `@astrojs/node` in `standalone` mode, then
  the Dockerfile adds the Lambda Web Adapter and `CMD ["node","./dist/server/entry.mjs"]`
  with `ENV PORT=8000`.
- **`@hivemind/agents` is a filesystem link.** `package.json` has
  `"@hivemind/agents": "link:../hivemind/packages/hive-agents"`. A CI job that
  clones HiveHub alone cannot resolve that. The package is already publishable —
  publish it and depend on a version, or build in a checkout that has both repos.
- **Secrets.** Four of them, in Secrets Manager, read at startup. Not Lambda env
  vars: `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` are forgeable if leaked —
  `SESSION_SECRET` signs the session cookie, so anyone holding it can mint a
  session for any account.
- **GitHub OAuth app.** Its callback URL must become
  `https://hivehub.griiken.com/auth/callback`, and the `state` cookie's `Secure`
  flag needs HTTPS — which CloudFront gives it.
- **Cookies through CloudFront.** The behaviour that hits Lambda must forward all
  cookies and query strings with `DefaultTTL: 0`, or sessions break and every
  visitor sees the first person's page. The S3 behaviour must do the opposite.
- **Install counts are writes.** Whatever database is chosen has to take a write
  per install event; the daily fingerprint salt (`COUNT_SECRET`) must be stable
  across Lambda instances, which it is as long as it comes from Secrets Manager.

## DNS

Both names sit under `griiken.com`. If the zone is already in Route53, add two
alias records to the two CloudFront distributions; if it lives elsewhere, either
move the zone or add CNAMEs for the sub-domains (sub-domains are fine as CNAMEs —
only an apex needs an alias). ACM certificates must be requested in **us-east-1**
regardless of where everything else lives, and one cert can carry both names.

## What it costs

Both sites sit inside the always-free tiers: CloudFront 1TB/month, Lambda 1M
requests, S3 5GB. The bills that appear by surprise are CloudWatch log retention
(set 30 days) and ECR image storage (lifecycle policy, keep 3). Set both on day
one, as in the guide.

## Open decisions

1. Database for HiveHub: Turso, stay on Cloudflare, or rewrite for DynamoDB.
2. Does the docs site keep publishing to GitHub Pages as well, or move entirely?
3. Who owns the AWS account and the OAuth app — the credentials and the callback
   URL have to belong to whoever operates it.
