# Fake Jira fixtures

Fixture Jira sites for the Jira sync tests (design: `docs/design/jira-sync-2026-10-23.md` §15).
The fake server, which ships with the Jira plugin in phase P2, answers every endpoint from a
**site model** rather than from one canned body per call. Its responses change as a test
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
