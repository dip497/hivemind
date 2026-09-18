# Hosting HiveHub on Google Cloud, minimally

Status: plan, 2026-09-18. For the plugin registry (`~/projects/hivehub`), today on Cloudflare
Workers + D1. Written from a read of every route and every SQL statement in that repo.

## What the thing actually is

Astro 5 SSR, ~17 TS files. Eight read paths (catalog, plugin page, publisher page, four JSON
APIs) and **three writes**:

| write | frequency | auth |
|---|---|---|
| `POST /api/publish` | a few times a week | signed session **and** a GitHub token with write on the repo |
| `GET /auth/callback` → upsert user | per sign-in | OAuth code + `state` nonce |
| `GET /api/v1/plugins/:id/resolve` → install counter | **every install** | none |

The data is ~95% seeded: 18 plugins, 52 KB, zero users, zero installs. The registry's own README
is right that "losing this database would lose install counts, not plugins".

**This is why the tempting answer is wrong.** A SQLite file baked into the container image costs
nothing and serves the reads perfectly — and then every install counter increments a file inside
one ephemeral instance, published plugins vanish on the next deploy, and two instances disagree.
Baking it in is only honest if publishing and counting are deleted first, which is the site.

## The only real question: where the writes live

Compute is not the cost. Cloud Run at `min-instances=0` serves this inside the free tier — the
docs site already does. The database is the entire decision.

| option | monthly | work | why |
|---|---|---|---|
| **Cloud Run + Firestore** | **$0** | ~1 day | free tier 50k reads/20k writes a day; scales to zero |
| Cloud Run + Cloud SQL | **$10–25 floor** | ~1 afternoon | a managed Postgres VM that cannot scale to zero, holding 52 KB |
| Cloud Run + SQLite in image | $0 | small | **breaks the three writes above** |
| stay on Cloudflare | $0 | none | D1 is free at this size and the pipeline works |

### Firestore, and the objection to it

The objection is that `listPlugins` does substring search over three columns with a dynamic sort
and a `LEFT JOIN users`, and Firestore does neither. That objection dies on the data size: **the
catalog is 18 rows and will be hundreds, not millions.** So the container holds the whole catalog
in memory and searches it there —

- cold start: read the `plugins` collection once (~18 docs), denormalise `publisher_login`
- serve `/`, `/api/v1/plugins`, `/api/v1/index.json` from that array, re-read on a 60s TTL
- `installs += 1` is `FieldValue.increment(1)`, which is atomic and needs no sharded counter at
  this volume; `installs_daily` is a document per `(plugin, day, fp)` with a TTL policy, which
  replaces the 0.2%-probability `DELETE` sweep the Workers version does by hand

That leaves Firestore doing what it is good at (key lookups and atomic increments) and nothing it
is bad at.

## The port, concretely

Every route already reaches the database through one accessor — `src/lib/ctx.ts:15`
`locals.runtime.env` — and every query goes through `db.prepare().bind().all()/.first()/.run()`.
So the migration is one adapter and one shim, not a rewrite:

1. `@astrojs/cloudflare` → `@astrojs/node` (standalone). One line in `astro.config.mjs`.
2. `env(ctx)` returns `{ DB, ...process.env }` from module scope instead of `locals.runtime.env`.
3. A ~40-line `db.ts` shim exposing the same `.prepare().bind()` surface over Firestore, so
   `counts.ts` and `registry.ts` are untouched.
4. Dockerfile. **It must vendor `@hivemind/agents`** — hivehub links it as
   `link:../hivemind/packages/hive-agents`, so a build context of `hivehub/` alone cannot resolve
   it. The existing GitHub workflow already checks out both repos; the container build needs the
   same, or the package published/copied in.
5. Secrets (`GITHUB_CLIENT_ID/SECRET`, `SESSION_SECRET`, `COUNT_SECRET`) into Secret Manager,
   mounted as env vars. GitHub OAuth callback URL has to be updated to the new origin.

Cloudflare-specific code is three things and all are already fallback-guarded: `locals.runtime`,
`ctx.waitUntil` (falls back to `await`), and `cf-connecting-ip` (falls back to
`x-forwarded-for`, which Cloud Run sets). Nothing else — no KV, no R2, no `caches`, no `request.cf`.

## Do this first, before any of it

The test suite has **seven unit tests and none of them touch the database layer**. The riskiest
part of the port is the part with zero coverage. Write tests for `db.ts` (list/filter/sort),
`counts.ts` (dedupe by fingerprint, day rotation) and `registry.ts`'s publish upsert against the
current D1 behaviour, then port until they pass again.

## Recommendation

If GCP is a preference rather than a requirement: **stay on Cloudflare for now.** D1 is free at
this size, the deploy works, and the Cloudflare surface is four files — the port stays this cheap
whenever you want it, so nothing is accruing.

If GCP is a requirement: **Cloud Run + Firestore**, one day of work, $0/month, with the
database-layer tests written first.

Either way the docs site stays exactly where it is.
