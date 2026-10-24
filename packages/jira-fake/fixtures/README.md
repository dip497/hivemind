# Fake Jira fixtures

Fixture Jira sites for the Jira sync tests (design: `docs/design/jira-sync-2026-10-23.md` §15).
The fake server (`src/server.ts`, below) answers every endpoint from a **site model** rather
than from one canned body per call. Its responses change as a test
transitions, assigns and comments, and a single model covers search, bulkfetch, transitions and
the agile calls without the fixtures drifting apart.

## Provenance

- **`*.site.json`.** Written on 2026-10-24 from Atlassian's OpenAPI specs: Cloud platform v3
  `1001.0.0-SNAPSHOT-12ca6ec5…`, Jira Software Cloud `1001.0.0`, and Jira Software Data Center
  `11.3.12`. Field names, enums and id formats follow the response schemas, and the status
  category ids and keys are Jira's real ones (`2 new`, `4 indeterminate`, `3 done`,
  `1 undefined`).
  - **They have not been recorded from a live site yet.** That needs the person's go-ahead and a
    sandbox site (design §17). Once recorded, replace the hand-made ids with the recorded ones
    and note the site and date here.
- **`openapi-schemas.json`.** The response schemas the server's schema check validates against
  (`User`, `SearchAndReconcileResults`, `BulkIssueResults`, `Transitions`, `IssueTypeWithStatus`,
  board configuration and list, `SprintBean`, and every component they reference), extracted
  from the same specs by `bun scripts/extract-schemas.ts <v3.json> <agile.json>`. Rerun it when the
  specs are updated; the specs themselves aren't committed.
- **`spec-examples/`.** The response and request examples Atlassian publishes in those specs,
  copied unchanged as provenance for field shapes.
  - **Don't serve them as-is.** They aren't consistent with each other: the transitions example
    uses the category keys `in-flight` and `completed`, and the `project/{key}/statuses` example
    leaves out `statusCategory`.
  - The sync's mapper must tolerate both: an unknown category key, and a status without a
    category. The `cloud-kanban-team` site has one, in the status `Triage`.

## Sites

| Site | Covers (design §) |
|---|---|
| `cloud-scrum-company` | **Project:** company-managed Scrum, and a second board on the same project (§6.2). **Workflows:** per-type workflows, with a 9-status Story workflow for the P0b e2e. **Transitions:** a screen with a required resolution, a validator field that isn't on the screen (400 `errors`), a `users` condition and an assignee-only condition (§8.2.6), a 2-hop path and a 4-hop path (§8.2.4), and a global Won't Do. **Sprints:** two active sprints, a future sprint and the backlog (§7.1). **Issues:** an epic and a sub-task; an ADF description with a panel, mention, status lozenge, emoji, media, code, and an AC task list (§6.5); a role-restricted comment and a multi-line comment; a `blocks` link and a flagged issue (§10 #6, #7); another install's `hivemind` entity property (§10 #10); a restricted and a deleted issue (§7.3). **Faults:** a burst 429, a per-issue write 429, near-limit, and 410 on the old search (§9.1). |
| `cloud-kanban-team` | **Project:** team-managed Kanban with the backlog enabled (first column) and a sub-filter, project-scoped statuses next to a global one, and a status with **no category**. **Fields:** team-managed field ids; no Sprint field and no AC field, with AC as a bold "Acceptance criteria" paragraph plus a bullet list. **Issues:** `OPS-7`, moved from `PAY-112` (same id `10212`; the changelog records the key change, §5.2). **Faults:** a quota 429. |
| `cloud-jwm-noboard` | Work Management project with no board; myself without `TRANSITION_ISSUES` or `ASSIGN_ISSUES` (§10 #8); a user without a time zone |
| `dc-v2-wiki` | Data Center 9.12 on REST v2: usernames instead of accountIds, wiki markup (with an AC list in `(/)`/`(x)` form), offset search, and an Epic Link field |

Each fault fires on the Nth request that matches its `method` and `path`, for `times` requests.
`siteProblems()` in `src/site.ts` checks that the models refer to each other correctly, and
`src/site.test.ts` checks that every shape in the table above is still covered.

## The fake server

`createFakeJira(site, opts?)` starts an HTTP server on `127.0.0.1` (a free port) that answers
the sync's REST calls from a **copy** of the site, and changes that copy as requests transition,
assign, comment, link and set properties.

```ts
import { createFakeJira, loadSite } from "@hivemind/jira-fake";

const jira = await createFakeJira(loadSite("cloud-scrum-company"), { now: () => clock });
const res = await fetch(`${jira.url}/rest/api/3/search/jql`, {
  method: "POST",
  headers: { Authorization: jira.authorization(), "Content-Type": "application/json" },
  body: JSON.stringify({ jql: "project = PAY AND assignee = currentUser()", fields: ["summary", "status"] }),
});
jira.site.issues.find((i) => i.key === "PAY-322")!.status = "3"; // someone moved it in Jira
expect(jira.requests.at(-1)!.path).toBe("/rest/api/3/search/jql");
await jira.close();
```

- **The handle.** `url` is the site URL; `gatewayUrl` is `url/ex/jira/<cloudId>` on Cloud.
  `site` is the live model: read it to assert on writes, and edit it to simulate another
  person's change. `requests` logs each call (method, path, query, body, status, `site` or
  `gateway`). `authorization("classic" | "scoped" | "pat")` gives the header value.
- **Auth.** On Cloud, a classic token (Basic `email:token`) works on the site URL only. A scoped
  token works only under `/ex/jira/{cloudId}`, and the site URL answers 401. With
  `credentials.scopes` set, Agile calls need a granular `…:jira-software` scope (401 "scope does
  not match" otherwise). On Data Center, only `Bearer <PAT>` works. `GET /_edge/tenant_info`
  returns `{cloudId}` without credentials. The defaults are in `fake.credentials`; override them
  with `opts.credentials`.
- **Options.**

  | Option | Effect |
  |---|---|
  | `now` | The clock: `updated` stamps, relative JQL dates, rate-limit windows, the 2026-11-01 Agile removal |
  | `admin` | `statuses/search` and `POST /workflows` answer; otherwise 401 (what the spec documents) |
  | `propertyBumpsUpdated` | Whether a property write bumps `updated`. Unknown in real Jira, so the default is `false` and the sync should pass both ways |
  | `perIssueWriteLimit` | `true` = 20 writes / 2 s and 100 / 30 s per issue → 429 `jira-per-issue-on-write`, or your own windows |
  | `limits` | Per-issue caps for comments (5000) and remote links (2000); 413 past them |
  | `issueErrors` | `{ idOrKey: message }`: bulkfetch reports these in `issueErrors[]` (retriable), not as missing |
  | `searchLagMs` | Search shows an issue as it was before a write for this long, unless `reconcileIssues` names it |

- **Faults.** The site's `faults` fire on the Nth request matching `method` and `path` (no query;
  `*` matches one segment), for `times` requests. A non-2xx fault replaces the response; a 2xx
  fault only adds its headers (`X-RateLimit-NearLimit`). Push to `jira.site.faults` to add one in
  a test. The scripted 429s fire in every test that uses that site, so a test that isn't about
  them should start from `{ ...site, faults: [] }`.
- **JQL.** A subset: `project`, `sprint` (`openSprints()`, `futureSprints()`, `closedSprints()`,
  an id or name), `assignee` / `reporter` (`currentUser()`, an accountId or username, `EMPTY`),
  `status`, `statusCategory`, `issuetype`, `priority`, `resolution`, `labels`, `id`, `key` (moved
  keys resolve), `parent`, `summary ~`, `updated` / `created` (`"yyyy-MM-dd HH:mm"` in myself's
  time zone, `-14d`-style periods, `now()`, `startOfDay()`, `endOfDay()`), with
  `AND`/`OR`/`NOT`/parentheses and `ORDER BY updated | created | key | id | Rank`. On Cloud an
  unknown field, function or value makes that clause match nothing, with no error (CHANGE-3131),
  and `POST /jql/parse?validation=strict` reports it. On Data Center it's a 400 unless
  `validateQuery=false`. `WAS` and `CHANGED` parse but match nothing. Without `ORDER BY` the order
  is newest id first; Jira's default isn't documented.
- **What's out of scope.** Issue creation and editing, attachments, worklogs, versions and
  rendered fields. An unknown path answers 404.

Choices made where Jira's behaviour isn't documented, so a sync test doesn't read them as fact:
`-1` as the assignee unassigns (the sites have no project lead); an unmet condition is checked
before screen fields; a global transition to the issue's current status isn't offered;
changelog items leave out a `null` side, because the spec's `ChangeDetails` doesn't allow `null`;
search embeds the *first* 20 comments.
