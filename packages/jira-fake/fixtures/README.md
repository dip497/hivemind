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
- **Edits.** `PUT /issue/{key}` sets `summary`, `labels`, `description` and `assignee` (each
  change in the changelog; any other field is a 400 and nothing is applied), and
  `PUT /issue/{key}/comment/{id}` edits a comment its author wrote (403 otherwise).
- **What's out of scope.** Issue creation, other field edits, attachments, worklogs, versions and
  rendered fields. An unknown path answers 404.

Choices made where Jira's behaviour isn't documented, so a sync test doesn't read them as fact:
`-1` as the assignee unassigns (the sites have no project lead); an unmet condition is checked
before screen fields; a global transition to the issue's current status isn't offered;
changelog items leave out a `null` side, because the spec's `ChangeDetails` doesn't allow `null`;
search embeds the *first* 20 comments.

## The fake Rovo MCP server

`createFakeRovoMcp(siteOrFakeJira, opts?)` (`src/mcp-server.ts`, tools in `src/mcp-tools.ts`)
stands in for `https://mcp.atlassian.com/v2/mcp` (design §9.2): Streamable HTTP, "Sign in with
Atlassian" (OAuth 2.1 with dynamic client registration, PKCE S256 and a loopback redirect), the
admin-enabled scoped API token, and the Jira tools the sync calls. Every tool is a REST call on
the fake Jira (`FakeJira.invoke`, in-process), so a sync over MCP and one over REST read and write
**one** Jira: pass a running `createFakeJira(...)` to share it, or a site to get a fresh one
(`fake.jira`). Its faults and write limits apply behind the MCP tools too.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFakeRovoMcp, loadSite } from "@hivemind/jira-fake";

const rovo = await createFakeRovoMcp(loadSite("cloud-scrum-company"), { now: () => clock });
// OAuth: give the transport your OAuthClientProvider. Its redirectToAuthorization(url) can just
// `await fetch(url)`: consent is automatic and the fetch follows the 302 to your loopback listener,
// which receives ?code=…; then transport.finishAuth(code) and connect again.
// src/mcp-server.test.ts has a complete LoopbackProvider.
const transport = new StreamableHTTPClientTransport(new URL(`${rovo.url}?tools=all`), { authProvider });
// Or the API token: createFakeRovoMcp(site, { apiTokens: true }) and
// { requestInit: { headers: { Authorization: rovo.oauth.apiTokenAuthorization() } } }.
const client = new Client({ name: "hivemind", version: "1.0.0" });
await client.connect(transport);
const r = await client.callTool({ name: "searchJiraIssuesUsingJql", arguments: { cloudId: rovo.site.cloudId, jql: "assignee = currentUser()" } });
JSON.parse(r.content[0].text).data.issues; // and r.structuredContent.issues.nodes / pageInfo
expect(rovo.requests.filter((x) => x.tool === "search")).toEqual([]); // the sync never spends credits
await rovo.close();
```

- **The handle.** `url` is the MCP endpoint (`…/v2/mcp`); `origin` serves the OAuth metadata and
  endpoints. `site` is the live model (the same object as `jira.site`). `requests` logs every HTTP
  request (`kind: "http"`, with the JSON-RPC method in `rpc`) and every tool call (`kind: "tool"`:
  `tool`, `args`, `auth`, `client` = the session's `clientInfo.name`, `isError`, `credits`).
  `oauth` has the registered `clients`, a `log` of register / authorize / token calls,
  `forgetClients()`, `expireAccessTokens()`, `setAppInstalled(bool)` and
  `apiTokenAuthorization("scoped" | "classic")`.
- **Options.**

  | Option | Effect |
  |---|---|
  | `now` | The clock for token lifetimes, the refresh idle limit and the hourly limit (also the REST fake's, when it creates one) |
  | `jira` | Options for the REST fake it creates (`admin`, `perIssueWriteLimit`, …) |
  | `accessTtlS` | Access-token lifetime; default 28800 |
  | `refreshIdleS` | A refresh token unused this long fails with `unauthorized_client: refresh_token is invalid` (#260); default 4 days |
  | `refreshGraceS` | How long a rotated-out refresh token still works; reuse after that revokes the grant. Default 10 |
  | `forgetClients` | Every client_id is forgotten once it has tokens (CHANGE-3170): the next refresh is `invalid_client` |
  | `allowLoopback: false` | The admin removed `http://127.0.0.1:*/**` / `http://localhost:*/**` from the allowlist: registration refuses a loopback redirect |
  | `allowedRedirects` | Non-loopback redirect URI prefixes the allowlist has |
  | `consent: false` | The person declines: the redirect carries `error=access_denied` |
  | `appNotInstalled` | The stale grant of #283 (see below) |
  | `apiTokens` / `apiTokenScopes` | The admin turned API tokens on / the scoped token's scopes |
  | `recognisedClients` | `structuredContent` only for these `clientInfo.name`s (#213); omitted = for everyone |
  | `maxParallel` / `latencyMs` | More MCP requests in flight than this → 429; `latencyMs` makes calls overlap. Default 20 / 0 |
  | `hourlyLimit` | Tool calls per rolling hour, then 429 until the oldest ages out |
  | `manageJira` | Lists `getJiraWorkflows` (the `manage_jira` group); it still needs the REST fake's `admin` |
  | `oldNames` | Also answers `findJiraIssueAssignableUsers` (renamed by CHANGE-3452) |
  | `unavailable` | Operation names this site lacks (#282 saw `listJiraBoards` / `listJiraBoardSprints` missing) |

### What it does

- **Transport.** `POST /v2/mcp` with JSON responses and an `Mcp-Session-Id` from `initialize`;
  `GET` is 405 (no stream), `DELETE` ends the session, an unknown session is HTTP 404 with
  `-32001 "Session not found"`, `/v1/sse` is 410. The protocol version is 2025-06-18 (what the
  live server answers). Plain `/v2/mcp` lists the 21 primary tools (`getJiraIssue`,
  `searchJiraIssuesUsingJql`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`,
  `discover`, `executeRead/Write/Destructive`, `search`, …); every other operation is reached with
  `discover` + `execute*` (`{name, cloudId, inputs}`, the runner must match). `?tools=all` lists
  all 215 flat, 50 to a page behind `nextCursor`.
- **Auth.** `401` + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/v2/mcp"`;
  the protected-resource metadata names a path-qualified issuer (`<origin>/fake-rovo-issuer`,
  like `auth.atlassian.com/<id>`), whose metadata is at
  `/.well-known/oauth-authorization-server/fake-rovo-issuer`; the bare
  `/.well-known/oauth-protected-resource` is 404, as live. DCR at
  `/fake-rovo-issuer/dcr/register`, `/authorize` (S256 only, the redirect must be registered and
  allowed), `/oauth/token` (code + verifier; refresh tokens only with `offline_access`, rotating),
  `/oauth/revoke`. An expired access token is a 401; the SDK refreshes and retries.
- **Output.** One text block holding `{"data": …}` JSON; `structuredContent` mirrors it, except
  that search and `getJiraIssue` use the `{issues: {nodes[] (with webUrl), webUrl, pageInfo:
  {hasNextPage, endCursor}, totalCount}}` envelope (#118, #213). Tool errors are
  `{"error": true, "message", "statusCode"}` text with `isError: true`. Rich text is markdown, or
  HTML when the body holds a panel, media, a mention, a status lozenge or an expand, with
  `appliedContentFormat` per issue / comment; `responseContentFormat: "adf"` is ignored (#189).
  Written bodies are markdown, stored as ADF. `cloudId` is required on every Jira tool and takes
  the UUID or the site URL; unknown arguments are dropped.
- **`getJiraIssue`.** The default `compact` view returns only `summary, description, status,
  assignee, priority, updated, attachment` (and custom fields) whatever `fields` asks (#256,
  #275); `view: "full"` returns what is asked. `comment` and `issuelinks` are never returned
  (`evidence` keeps the links): comments come from `listJiraIssueComments`. Search honours `fields`
  exactly; `customfield_*` values come back under `fields.customFields` by field name.
- **Limits.** 429 with only `Retry-After` and `{"error":"too_many_requests",…}`, for concurrency or
  the hourly limit (#171). `search` (Rovo semantic search) is logged with 10 credits; Jira tools
  with 0.
- **Stale grant (#283).** Jira tools answer `{"code":403,"message":"The app is not installed on
  this instance"}` (`isError`), while `getAccessibleAtlassianResources` still answers, without
  `scopes`.

### What this means for the MCP transport (P2/P3)

- Read issues through search (exact `fields`) or `getJiraIssue` with `view: "full"`; the compact
  view silently drops `issuetype`, `labels` and `parent`.
- Call with `?tools=all`, or go through `executeRead` for the non-primary operations:
  `listJiraIssueTransitions` and friends are not callable by name on plain `/v2/mcp`.
- **Remote links can't be upserted**: `createJiraIssueRemoteIssueLink` has no `globalId`, so a
  retry adds a duplicate, and listing returns no `globalId` to match on (§8.1 relies on it).
- The SDK's `StreamableHTTPError` for a 429 doesn't carry `Retry-After`: read it with a `fetch`
  wrapper.
- An idle refresh failure is `unauthorized_client`, which the SDK answers by re-registering and
  sending the person back to consent: the tile's "sign in again".
- The SDK can refresh twice at once (its GET stream and a POST meet the same expired token). With
  `refreshGraceS: 0` that kills the grant; serialize refreshes in the provider.

### Sources (read 2026-10-24)

- developer.atlassian.com/cloud/rovo-mcp/ (supported tools, updated 2026-09-30; auth pages) and
  github.com/atlassian/atlassian-mcp-server (README; issues #89, #118, #171, #189, #213, #256,
  #260, #275, #281, #282, #283).
- The live metadata: `https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp` and
  its authorization server's metadata.
- `fixtures/rovo-mcp-tools.json`, built by `bun scripts/extract-rovo-tools.ts` from two captures
  of the live server published in clssck/atl-cli: `mcp/tools-v2.json` (a `tools/list` of plain
  `/v2/mcp`: the 21 primary tools with their full `inputSchema`s) and `mcp/operations-v2.json`
  (`discover` on all 192 operations, 2026-10-22: runner and inputs). Those captures are © their authors under the MIT licence
  (github.com/clssck/atl-cli/blob/main/LICENSE); the tool schemas themselves are Atlassian's
  published interface. A third capture
  (Team-Commonly/commonly, 2026-10-19) gave `expires_in: 28800` and the granted scopes.
- One third-party live report (evanstern/praxisflux, 2026-09-09) for the transitions entries and
  search paging.

### ASSUMED (nothing published; change it in one place)

| Behaviour | Fake's choice | Where |
|---|---|---|
| `?tools=all` page size | 50 (docs say only "paginated") | `ROVO.pageSize` |
| Output of tools other than search / getJiraIssue | `{"data": <the REST body, rich text converted>}`; structuredContent `{data}` | `ok()` and each handler in `mcp-tools.ts` |
| Search text | `{data: {issues, nextPageToken?, isLast}}`; `searchResultMode: "count"` gives `{total}` | `searchPage()` |
| `totalCount` in the search envelope | The page's size (#118's bug, assumed still there) | `searchPage()` |
| Tool errors | `isError: true` is set (reports differ) | `fail()` |
| Wrong `cloudId` / missing input messages | `404 "No accessible Atlassian site matches…"` / `400 "Invalid input: X is required"`; types are checked strictly | `checkCloud()`, `checkArgs()` |
| `transitionJiraIssue` output | `{key, transition: {id, name}, status}` | its handler |
| `listJiraStatuses` `mode` | `"project"` (per issue type, needs `projectKey`) or `"search"` (filters) | its handler |
| `getJiraBoardIssueData` `dataset` | `"board"` (the filter, default) or `"backlog"` | its handler |
| `listJiraBoards`, `listJiraBoardSprints`, `getJiraWorkflows` inputs | Not in any capture; REST-like | `EXTRA`, `MANAGE` |
| Comment / edit bodies | Markdown only; `contentFormat: "html"` is refused | `bodyIn()` |
| How HTML / markdown render panels, mentions, lozenges, media | `src/markdown.ts` | `adfToHtml()`, `adfToMarkdown()` |
| `getAccessibleAtlassianResources` | One Jira entry; `avatarUrl` present | its handler |
| `atlassianUserInfo` | `{account_id, email, name, picture, account_status, nickname, zoneinfo, locale}` | its handler |
| `search` results | Words of the query in summaries; `{results: [{id (ARI), title, url, type, lastModified}]}` | its handler |
| 429 body on the MCP endpoint | auth.atlassian.com's `too_many_requests` body | `ROVO.rateLimited` |
| "App not installed" | A tool error, not HTTP 403 (#283's resources call still answered) | `makeTool()` |
| Refresh-token reuse | 10 s grace, then the grant is revoked | `refreshGraceS` |
| Sessions | Stateful (`Mcp-Session-Id`) | `mcp-server.ts` |
| `client_id_metadata_document_supported` | Not advertised (live says `true`; the fake can't fetch a CIMD URL) | `authServer()` |
| Sprint moves in `transitionJiraIssue`, `fetch`, Confluence and the other products' tools | Listed where captured; calling them is a 501 tool error | `HANDLERS` |
