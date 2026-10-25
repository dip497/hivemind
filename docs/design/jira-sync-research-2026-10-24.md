# Jira sync: research notes (2026-10-24)

These notes back `jira-sync-2026-10-23.md`. Endpoint shapes come from Atlassian's OpenAPI
specs, downloaded 2026-10-24:

- [Cloud platform v3](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json)
- [Cloud software](https://developer.atlassian.com/cloud/jira/software/swagger.v3.json)
- [DC 11.3](https://developer.atlassian.com/server/jira/platform/jira_software_dc_11003_swagger.v3.json)

Everything else comes from the docs linked inline. **UNVERIFIED** marks a claim that no official
page confirmed. Phase P-R closes each one, or the design stops relying on it.

## A. Jira REST (Cloud v3, Agile, DC)

### A.1 Identity

| Endpoint | Use | Permission |
|---|---|---|
| `GET /rest/api/3/myself` | `accountId`, `displayName`, `emailAddress` (may be null), `timeZone`, `locale`, `accountType` | Jira access |
| `GET /rest/api/3/user/assignable/search?issueKey=&query=` | Assignee picker; `actionDescriptorId` = transition id | *Assign issues* |
| `GET /rest/api/3/user/search?query=` | Map people; empty result without *Browse users* | *Browse users and groups* |

Key users by `accountId`; `name`/`key` were removed on Cloud. Data Center has no `accountId` and
uses `name`/`key` (username) through `/rest/api/2/myself`.

### A.2 Workflow shape

- **`GET /rest/api/3/project/{key}/statuses`** returns `[{id, name, subtask, statuses:[{id, name,
  statusCategory:{id, key, colorName}}]}]`, grouped by issue type.
  - This is the main source, and any user with *Browse projects* can call it.
  - Category keys are `new` / `indeterminate` / `done` / `undefined`.
- `GET /rest/api/3/statuses/search` and `GET /rest/api/3/statuses?id=` need **admin** (Administer
  projects or Jira).
- **Full workflow graph:**
  - `POST /rest/api/3/workflows` takes `{projectAndIssueTypes:[{projectId, issueTypeId}]}`.
  - `GET /rest/api/3/workflows/search?projectId=&scope=GLOBAL|PROJECT&expand=values.transitions`
    lists them.
  - Both need *Administer Jira*. For project-scoped workflows, *Administer projects* or the *View
    (read-only) workflow* project permission is enough.
  - Each transition is `{id, name, type: INITIAL|GLOBAL|DIRECTED, links:[{fromStatusReference}],
    toStatusReference, conditions, validators, transitionScreen}`. Statuses there carry
    `statusCategory: TODO|IN_PROGRESS|DONE`.
- `GET /rest/api/3/workflowscheme/project` is admin-only and silently ignores team-managed
  projects.
- `GET /rest/api/3/workflow/search` is **deprecated**, with removal scheduled for 2026-06-01
  ([CHANGE-2569](https://developer.atlassian.com/cloud/jira/platform/changelog/#CHANGE-2569)). Do
  not use it.
- **Fallback for non-admins:** `GET /rest/api/3/issue/{key}/transitions?expand=transitions.fields&includeUnavailableTransitions=true`.
  - It returns the transitions from the issue's current status, for this user.
  - Build the graph lazily from these responses.
  - Validators that aren't screen fields only show up as 400 errors.
- **Project style:** `GET /rest/api/3/project/{key}?expand=issueTypeHierarchy,projectKeys` returns:
  - `style` (`classic` | `next-gen`), `simplified`, `projectTypeKey`, `archived`;
  - `projectKeys`, which lists every key the project has ever had.

  Team-managed projects:
  - Statuses and types are project-scoped and workflows have `scope=PROJECT`.
  - `GET /rest/api/3/project/{projectId}/hierarchy` returns the hierarchy.
  - Global statuses in team-managed workflows went GA on 2026-10-12, so **a status id may be shared
    across projects**.
  - New *experimental* "space policy" APIs exist (2026-10-15); don't build on them.
- **Terminology:** the Jira UI now says "spaces" and "work items". REST paths still say project
  and issue.

### A.3 Boards (Agile)

- `GET /rest/agile/1.0/board?projectKeyOrId=&type=scrum|kanban|simple` (offset paging).
- `GET /rest/agile/1.0/board/{id}/configuration` returns:
  - `filter.id`;
  - `subQuery.query` (the Kanban sub-filter);
  - `columnConfig.columns[{name, statuses[{id}], min, max}]`;
  - `estimation{type, field{fieldId, displayName}}`;
  - `ranking.rankCustomFieldId`.
- Column rules:
  - **The last column with mapped statuses counts as Done.**
  - Statuses not mapped to a column are not on the board.
  - UNVERIFIED: how a Kanban backlog appears in the column config.
- Board JQL comes from `GET /rest/api/3/filter/{filterId}` (`jql`). There is no
  `/board/{id}/filter` endpoint.
- `GET /rest/agile/1.0/board/{id}/features` reports sprint, backlog and estimation enablement
  (shape UNVERIFIED).
- Sprints:
  - `GET /rest/agile/1.0/board/{id}/sprint?state=active,future,closed` is still current. More than
    one sprint can be active.
  - `POST /rest/agile/1.0/sprint/{id}/issue` moves issues into a sprint, at most 50 per call.
- Rank: `PUT /rest/agile/1.0/issue/rank`.
- Estimate: `GET/PUT /rest/agile/1.0/issue/{key}/estimation?boardId=`.
- **Deprecated:** every `/rest/agile/1.0/.../issue` listing (board, backlog, sprint and epic
  issues).
  - The replacements live under **`/rest/software/1.0/...`** with the same sub-paths. They use
    `nextPageToken` and allow up to 5000 results.
  - Source: [RFC-127](https://community.developer.atlassian.com/t/rfc-127-jira-software-cloud-api-changes-improving-scalability-for-software-space-issue-results/98871),
    from 2026-02.
  - The removal date is UNVERIFIED.
  - Prefer plain JQL through `search/jql`.

### A.4 Fetching issues

- **`GET|POST /rest/api/3/search/jql`**
  - The `jql` must be bounded.
  - Paging is `nextPageToken` only. Tokens expire after 7 days; there is no `total` and no
    `startAt`.
  - **`fields` defaults to `id` only.**
  - `expand` accepts `names`, `schema`, `changelog`, `renderedFields`, `transitions`, `editmeta`.
  - `properties` takes up to 5 entity properties.
  - `reconcileIssues` takes up to 50 ids, for read-after-write.
  - `maxResults` goes up to 5000 for id/key only, and is about 100 in practice with full fields.
  - Results are eventually consistent.
- Search returns **at most 20 comments and 20 changelog entries** per issue (secondary sources,
  UNVERIFIED). Fetch the rest from the dedicated endpoints.
- `/rest/api/3/search` and `/rest/api/2/search` (`startAt`) on Cloud were deprecated under
  [CHANGE-2046](https://developer.atlassian.com/changelog/#CHANGE-2046) and now return **410**.
- `POST /rest/api/3/search/approximate-count` gives estimates only.
- **`POST /rest/api/3/jql/match`** takes 10 queries × 50 ids and says which issues match which
  query. Use it for re-checking scope membership.
- **`POST /rest/api/3/issue/bulkfetch`**
  - Takes up to 100 ids, or 1000 with at most 100 single-value fields.
  - Missing and forbidden issues are **silently omitted**.
  - **Moved keys resolve to the issue.**
- JQL:
  - `sprint in openSprints()` means started and not completed, so future sprints are excluded;
    use `futureSprints()` for those.
  - `assignee = currentUser()`, `assignee is EMPTY`.
  - `updated >= "yyyy-MM-dd HH:mm"`: **minute precision, in the caller's profile time zone**.
    Relative forms like `-5m` also work.
  - `parent = KEY`. The JQL "Epic link" function was retired in 2024.
- Fields:
  - `GET /rest/api/3/field` returns `[{id, name, custom, schema{type, custom, customId},
    clauseNames}]`.
  - **Identify custom fields by `schema.custom`, not by name.** Sprint is
    `com.pyxis.greenhopper.jira:gh-sprint`.
  - Rank is `gh-lexo-rank` and Team is `atlassian-team` (both UNVERIFIED).
  - Story points: prefer the board's `estimation.field.fieldId`. It differs between
    company-managed and team-managed projects.
  - Acceptance criteria has **no standard field**. Detect it per site and have the person
    confirm.
  - `GET /rest/api/3/issue/{key}/editmeta` gives editability per issue and user.
- Hierarchy:
  - `issuetype.hierarchyLevel`: −1 sub-task, 0 standard, 1 epic, ≥2 Plans levels. The level
    meanings are convention, UNVERIFIED in the spec.
  - Use the `parent` field for both sub-tasks and epic children. The Epic Link and Parent Link
    fields are deprecated.
- **Changelog:**
  - **`POST /rest/api/3/changelog/bulkfetch`** takes `{issueIdsOrKeys[≤1000], fieldIds[≤10],
    maxResults ≤10000, nextPageToken}`. **Filter it to `status` and `assignee`.**
  - Per issue: `GET /rest/api/3/issue/{key}/changelog`, offset paging, oldest first.
- Comments: `GET /rest/api/3/issue/{key}/comment?orderBy=created`, offset paging, max 100. In v3
  the body is ADF.
- Rich text:
  - Cloud v3 uses ADF.
  - Cloud v2 (`/rest/api/2`) takes and returns **wiki markup**, converted server-side. That is an
    alternative to converting ADF ourselves.
  - DC is v2 wiki only.
  - Converters:
    - Atlaskit `@atlaskit/editor-markdown-transformer` handles md → ADF. ADF → md is UNVERIFIED.
    - Community converters: `marklassian` (md → ADF), `adf-to-md`, `adf2md`.
    - Expect loss on mentions, panels and media.

### A.5 Writes

| Action | Endpoint | Notes |
|---|---|---|
| List transitions | `GET /issue/{key}/transitions?expand=transitions.fields&includeUnavailableTransitions=true&sortByOpsBarAndStatus=true` | `{id, name, to{id, statusCategory}, hasScreen, isGlobal, isInitial, isAvailable, isConditional, looped, fields{id:{required, schema, allowedValues, hasDefaultValue}}}`; empty without *Transition issues* |
| Transition | `POST /issue/{key}/transitions` `{transition:{id}, fields:{resolution:{name}}, update:{comment:[{add:{body:ADF}}]}}` | Set `resolution` only if it's in `transitions.fields`; required non-screen fields → 400 `errors{}` |
| Edit | `PUT /issue/{key}` `{fields, update}` (`notifyUsers`) | can't change status |
| Assign | `PUT /issue/{key}/assignee` `{accountId}`; `null` unassigns, `"-1"` = project default | *Assign issues* |
| Comment | `POST /issue/{key}/comment` `{body: ADF, visibility?}` | *Add comments* |
| Remote link | `POST /issue/{key}/remotelink` `{globalId:"github-pr:org/repo#12", application, relationship, object:{url, title, icon, status:{resolved}}}` | **Idempotent upsert by `globalId`**; `DELETE ?globalId=` |
| Create | `POST /issue`; metadata `GET /issue/createmeta/{project}/issuetypes[/{id}]` | old `GET /issue/createmeta` deprecated (CHANGE-1304) |
| Entity property | `PUT /issue/{key}/properties/{key}` (≤32 KB) | *Edit issues*; 3LO apps can't query properties in JQL; whether it touches `updated` is UNVERIFIED |

### A.6 GitHub / development info

- **GitHub for Jira** links branches, commits and PR titles that contain the issue key
  ([docs](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)).
- **Smart commits** (`KEY-1 #comment … #transition`) need the committer's email to match exactly
  one Jira user, and fail silently on transitions with required fields. **Don't rely on them.**
- **Reading linked PRs from Jira:** there is no public API. `/rest/dev-status/latest/...` is
  internal ([JRACLOUD-92947](https://jira.atlassian.com/browse/JRACLOUD-92947)).
  - **Read PRs from GitHub** (`gh`), and write Jira remote links ourselves.

### A.7 Auth

- **Classic API token:** Basic `email:token` against `https://<site>.atlassian.net`.
  - Since 2024-12-15 tokens expire after 1–365 days.
  - Older tokens expired between 2026-03-14 and 2026-05-12.
  - "Unscoped tokens are being deprecated", date UNVERIFIED
    ([docs](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)).
- **Scoped API token:** Basic `email:token`, **only** through
  `https://api.atlassian.com/ex/jira/{cloudId}/rest/...`. The site URL returns 401.
  - cloudId comes from `https://<site>.atlassian.net/_edge/tenant_info` (UNVERIFIED as an
    official endpoint).
- **API-token traffic is not subject to the points quota**, only to the burst limits (A.8). This is
  why API tokens are the default.
- **OAuth 2.0 (3LO):** `client_secret` is required for both the code exchange and refresh.
  - **No PKCE on Cloud**: [ECO-283](https://jira.atlassian.com/browse/ECO-283) is still
    "Gathering Interest".
  - `offline_access` issues rotating refresh tokens: 90-day inactivity expiry, a 10-minute reuse
    window.
  - `accessible-resources` returns the cloudId.
  - 3LO traffic counts toward the **app-wide** 65k points/hour pool.
  - Atlassian: apps that "collect API tokens or instruct customers to create individual 3LO apps
    don't comply". That targets distributed apps, so weigh it when we publish.
  - **Deferred.** It needs a secret-holding broker.
- **Data Center:** PAT as `Authorization: Bearer <PAT>` (Jira 8.14+). Defaults: 10 tokens per user
  and a 365-day maximum expiry.
  - Paths `/rest/api/2` and `/rest/agile/1.0`.
  - Search is offset-based (`startAt`, `total`); see `/rest/api/2/searchLimits/maxResultWindow`.
  - **DC end of life is 2029-03-28.**

### A.8 Rate limits

Source: [rate-limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/),
updated 2026-10-23.

- **Points quota** (Forge, Connect and 3LO; enforced since 2026-03-02):
  - Each request costs 1 point, +1 per core object read, +2 per identity object.
  - The default is 65k points/hour per app across all tenants.
  - It resets on the UTC hour.
- **Burst** (applies to everyone, API tokens included): a token bucket per tenant per endpoint.
  GET/POST 100/s, PUT/DELETE 50/s, `GET issue` 150/s.
- **Per-issue writes:** 20 per 2 s and 100 per 30 s.
- **Headers:**
  - `Retry-After`;
  - `X-RateLimit-Limit`, `-Remaining`, `-Reset` (Reset only with a 429);
  - `X-RateLimit-NearLimit` (under 20% left);
  - `RateLimit-Reason`: `jira-quota-global-based`, `-tenant-based`, `jira-burst-based`,
    `jira-per-issue-on-write`.
- **Backoff:**
  - Honour `Retry-After`. Otherwise back off exponentially from 2–5 s up to 30 s, with ×0.7–1.3
    jitter and at most 4 retries, and only for idempotent requests.
  - Quota reason → pause everything until the reset.
  - Burst reason → slow down that endpoint only.

### A.9 Change notifications

- **Dynamic webhooks** (`/rest/api/3/webhook`):
  - Available only to Connect and OAuth apps.
  - They **expire after 30 days**, and there are 5 per app per user.
  - The JQL filter subset is limited.
- **Admin webhooks** are configured by admins, can carry a `secret`, and send `X-Hub-Signature`.
- **Delivery** needs **public HTTPS** with a trusted certificate. Jira retries up to 5 times;
  dedupe on `X-Atlassian-Webhook-Identifier`.
- **A desktop app can't receive webhooks.** Poll with `updated >=`. Relay options for later: a
  Forge app, a hosted relay, or a tunnel.

### A.10 Gotchas

- **Restricted issues** are just absent: no error.
- **Moved / re-keyed issues:** `GET /issue/{oldKey}` and bulkfetch return the issue under its
  **new key**, with no redirect. **The sync identity is the immutable `id`**; the changelog records
  `Key` and `project` changes.
- **Deleted issues:** there's no tombstone, and the 404 looks the same as lost permission.
  Confirmation needs the `issue_deleted` webhook or the audit log, both admin-only.
- **Archived:** projects are skipped by search unless `includeArchivedProjects=true`. Archived
  issues (Premium) drop out of search.
- **Time zones:** JQL dates use the caller's profile time zone (`myself.timeZone`).
  `serverInfo.serverTime` helps detect clock skew.
- **Page sizes:**

  | Endpoint | Page size |
  |---|---|
  | search/jql | ~100 with full fields |
  | bulkfetch | 100 or 1000 |
  | changelog bulkfetch | up to 10000 |
  | comments | 100 |
  | project/search | 100 |
  | createmeta | 200 |
  | agile | 50 |

## B. MCP

### B.1 Atlassian Rovo MCP Server (Cloud)

**Status and endpoints**
- Beta 2025-05-01, GA 2026-02-04, then v2 later in 2026
  ([GA post](https://www.atlassian.com/blog/announcements/atlassian-rovo-mcp-ga),
  [repo](https://github.com/atlassian/atlassian-mcp-server),
  [docs](https://developer.atlassian.com/cloud/rovo-mcp/)).
- Endpoints:

  | Endpoint | Status |
  |---|---|
  | `https://mcp.atlassian.com/v2/mcp` (Streamable HTTP) | recommended |
  | `?tools=all` on the same URL | a flat paginated tool list, for programmatic clients |
  | `/v1/mcp` | still supported |
  | `/v1/sse` | unsupported after 2026-06-30 |

  From 2027-03-01, v1 traffic gets v2 tools.
- In practice it is Cloud only.

**Jira tools (v2)**
- **Read:** getJiraIssue, listJiraIssueComments, listJiraIssueChangelogs, listJiraIssueWorklogs,
  listJiraIssueRemoteIssueLinks, listJiraIssueLinkTypes, getJiraEntityProperty, listJiraProjects,
  listJiraProjectIssueTypesMetadata, getJiraIssueTypeMetaWithFields, listJiraProjectComponents,
  getJiraProjectVersions, listJiraIssueTransitions, listJiraStatuses, lookupJiraAccountId,
  listJiraIssueAssignableUsers, getJiraCurrentUser, getJiraUser, listJiraBoards,
  getJiraBoardConfig, getJiraBoardIssueData, getJiraBoardSprintData, listJiraBoardSprints,
  listJiraFilters.
- **Search:** searchJiraIssuesUsingJql. Its `structuredContent` is `{issues:{nodes[],
  pageInfo:{hasNextPage, endCursor}}}`.
- **Write:** createJiraIssue, editJiraIssue, transitionJiraIssue (also moves issues to a sprint or
  the backlog), addOrEditJiraIssueComment, createJiraIssueLink, createJiraIssueRemoteIssueLink,
  editJiraEntityProperty, manageJiraSprint, watchJiraIssue.
- **Off by default:**
  - `delete_jira`.
  - `manage_jira`, which includes **getJiraWorkflows**. So the full workflow graph needs an admin
    to enable it.
- **Meta:** getAccessibleAtlassianResources (gives the cloudId), atlassianUserInfo, discover,
  executeRead/Write/Destructive.
- **`search`** is Rovo semantic search, and **costs Rovo credits**: 1–10 per call, overage billed
  from 2026-12-03. Single-product lookups and writes are free.
  [Usage limits](https://support.atlassian.com/rovo/docs/rovo-usage-limits/).

**Auth**
- **OAuth 2.1:** browser consent, bound to a cloudId. DCR works in practice (issue #213). PKCE is
  required by the MCP spec, but Atlassian doesn't state it.
  - Atlassian's default domain allowlist **includes `http://localhost:*/**` and
    `http://127.0.0.1:*/**`**, so a custom local client with a loopback redirect is allowed unless
    an admin narrows the list
    ([domains](https://support.atlassian.com/security-and-access-policies/docs/available-atlassian-rovo-mcp-server-domains/)).
- **API token:** shipped in 2026, and an **org admin must enable it**
  ([docs](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token/)).
  - Personal: Basic `email:token`, optionally a scoped token.
  - Service account: `Bearer <api_key>`.
  - Tokens aren't bound to a cloudId, so it is passed explicitly.
  - IP allowlists still apply.
- **Token lifetime and refresh rotation:** UNVERIFIED.

**Limits**
- Hourly limits are UNVERIFIED. A community thread quotes Free 500/h, Standard 1000/h, and
  Premium/Enterprise 1000 + 20 per user, up to 10k/h.
- 429s were reported at about 20 parallel calls, returning `Retry-After` only (issue #171).

**Output (the main risk)**
- Rich text is **markdown only**. `responseContentFormat: "adf"` is ignored (#189).
- `structuredContent` was **withheld unless `clientInfo.name` is a recognised client** such as
  `claude-code` or `cursor` (#213, v1 authv2). Whether v2 does the same is UNVERIFIED.
- There have been schema bugs before (#89).
- Treat it as best-effort: validate every response.

**Gaps compared with REST:** no webhooks, no bulk changelog, no `/field` equivalent, markdown-only
rich text, admin-gated workflow graph, unversioned shapes.

### B.2 `sooperset/mcp-atlassian`

- MIT licence. v0.23.1 was released 2026-08-19, and the repo is active.
  [Repo](https://github.com/sooperset/mcp-atlassian).
- Supports Cloud and DC 8.14+, with API token, PAT or OAuth auth, over stdio, SSE or
  streamable-http.
- Configuration: `READ_ONLY_MODE`, `TOOLSETS`, `ENABLED_TOOLS`.
- **Output is JSON text** with `readOnlyHint`, so it parses deterministically.
- Relevant tools: jira_search, jira_get_issue, jira_get_transitions, jira_transition_issue,
  jira_update_issue, jira_assign_issue, jira_add_comment, jira_batch_get_changelogs,
  jira_search_fields, jira_get_agile_boards, jira_get_board_issues, jira_get_sprints_from_board,
  jira_get_sprint_issues, jira_create_remote_issue_link, jira_search_assignable_users,
  jira_get_issue_development_info, jira_get_project_epic_hierarchy.
- It's Python (uvx or Docker), so we don't bundle it. Users who already run it can pick it.

### B.3 Node MCP client

- **SDK v2** is split into packages: `@modelcontextprotocol/client@2.4.0` (2026-10-23, Node ≥20).
- **v1 monolith:** `@modelcontextprotocol/sdk@1.32.2`, still maintained.
  [Repo](https://github.com/modelcontextprotocol/typescript-sdk).
- **Classes:** `Client` and `StreamableHTTPClientTransport`. `SSEClientTransport` is deprecated.
- **OAuth:** `OAuthClientProvider` exposes `redirectUrl`, `clientMetadata`,
  `clientInformation`/`saveClientInformation` (DCR), `tokens`/`saveTokens`,
  `redirectToAuthorization`, and `saveCodeVerifier`/`codeVerifier` (PKCE).
  - In Electron, implement `redirectToAuthorization` with `shell.openExternal` and a loopback
    listener.
- **API-token mode:** set `requestInit.headers.Authorization`.
- **Spec 2026-07-28:** stateless, `_meta` clientInfo, and `structuredContent` MUST match
  `outputSchema`.
- **Practical notes:**
  - Use `?tools=all`.
  - Set `clientInfo.name`, then check that `structuredContent` actually arrives.

## C. Conclusions that shape the design

1. **The sync key is the Jira issue `id`, not its key.** Keys change when issues move between
   projects.
2. **Non-admins can't read workflow graphs.** Build the transition graph lazily from per-issue
   `GET transitions`, and read statuses from `/project/{key}/statuses`.
3. **Use `search/jql` and `bulkfetch`.**
   - Search returns only `id` by default, so always pass `fields`.
   - Search caps embedded comments and changelog entries at about 20, so fetch those separately.
   - `changelog/bulkfetch`, filtered to status and assignee, serves conflict decisions.
4. **Board issue listing has moved to `/rest/software/1.0`.** Prefer JQL plus the board filter.
5. **Default auth is a user-supplied API token**, which is exempt from the points quota. Scoped
   tokens need the `api.atlassian.com/ex/jira/{cloudId}` base. OAuth 3LO has no PKCE and needs a
   client secret, so it's deferred. The MCP OAuth path (DCR + PKCE + loopback) gives "sign in with
   Atlassian" without a secret.
6. **There's no public "linked PRs" API.** GitHub is the source of PR state. Jira gets
   idempotent remote links keyed by `globalId`.
7. **Polling only.** Webhooks need public HTTPS.
8. **MCP output is semi-structured, so MCP is the second transport and REST the default.** Never
   call Rovo `search` (it costs credits).
9. **Data Center:** v2, a PAT, wiki markup, offset search, usernames instead of accountIds.
   End of life 2029-03-28.

## D. P-R verdicts (2026-10-24)

Each UNVERIFIED item above, closed or designed around. The design's §18 lists every correction;
the full source list is in the P-R comment on HIVEMI-1.

| Item (section) | Verdict |
|---|---|
| Kanban backlog in `columnConfig` (A.3) | **Community-sourced only.** Kanban boards always return a first column "Backlog". `statuses: []` = a placeholder (no backlog); statuses + `features.BACKLOG` enabled = the Kanban backlog. Encoded in the fixtures; re-check on the live smoke. |
| `/board/{id}/features` shape (A.3) | **Verified (OpenAPI):** `features[{boardFeature, state: ENABLED\|DISABLED\|COMING_SOON, featureType, …}]`. Needs `read:board-scope.admin:jira-software` on scoped tokens. |
| RFC-127 removal date (A.3) | **Verified:** CHANGE-3193 (2026-05-01). The `/rest/agile/1.0/.../issue` listings are removed **after 2026-11-01**. Replacements under `/rest/software/1.0` (CHANGE-3192). |
| 20 comments / changelog in search (A.4) | **Corrected:** 20 comments and **40** changelog items (CHANGE-2046). |
| Rank / Team type keys (A.4) | Rank `gh-lexo-rank` verified (KB). **Team corrected** to `com.atlassian.teams:rm-teams-custom-field-team` (Teams REST doc, 2026-09-15); accept `atlassian-team` too. Flagged and story-point keys are still unverified: match on schema + name, and the person confirms. |
| `hierarchyLevel` meanings (A.4) | **Verified:** −1 sub-task, 0 standard, 1 epic, ≥2 Premium levels. |
| ADF → md (A.4) | **Corrected:** `@atlaskit/editor-markdown-transformer` can't do ADF → md (`encode()` throws). Chosen: `mdast-util-from-adf` (ADF → md) and `marklassian` (md → ADF). `adf2md` is dead; `adf-to-md` is unmaintained. |
| Property write bumps `updated` (A.5) | **Still unverified** (no doc). The ledger ignores the `updated` our own writes return either way; needs a live test. |
| Unscoped token deprecation date (A.7) | **Corrected:** none announced. The token page only recommends scopes. |
| `_edge/tenant_info` (A.7) | **Documented in Atlassian's KB** (2026-03-31), not as an API; the wizard falls back to asking for the cloudId. |
| Rovo token lifetime / rotation (B.1) | **Still unverified.** Issues report ~1 h access tokens, refresh failures after ~4 idle days (#260) and 403 "app not installed" (#283); all are treated as "sign in again". DCR results must not be cached (CHANGE-3170). |
| Rovo hourly limits (B.1) | **Still unverified.** Only third-party figures exist; concurrency stays at 3. |
| Rovo `structuredContent` gating on v2 (B.1) | **Still unverified** (#213 open, v1 only). P4 records a v2 session to settle it. |

New facts found in P-R, not in the notes above:
- Since CHANGE-3131 (2026-06-29), invalid JQL clauses return zero results instead of an error.
  Validate with `POST /rest/api/3/jql/parse`.
- `issue/bulkfetch` reports retriable failures in `issueErrors[]`. It takes 1000 ids only with
  explicit, single-value fields (at most 100).
- On v3, `serverInfo.deploymentType` is always `Cloud`. DC's schema doesn't document it.
- `priority/search` needs `manage:jira-configuration`.
- A remote-link update nulls the fields it omits. `POST transitions` takes `properties` and can
  answer 409, 413 or 422.
- The Rovo MCP API token must be scoped (`read`/`write`/`search:jira:agent-interface`), and
  `cloudId` is a tool argument.
- DC 11.3 lacks `bulkfetch`, `jql/match`, `changelog/bulkfetch` and the per-issue `changelog`.
