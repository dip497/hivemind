# AGENTS.md — packages/hive-core

The storage + parsing layer for `.hivemind/`. Pure TypeScript, no Electron, no
React — consumed by the desktop main process, the `hive` CLI, and the MCP server.
Ships `.ts` source via `package.json` `main` (bundled by consumers; no build).

## Modules

```
src/
  types.ts          Issue / IssueState / AcceptanceItem / LinkType / IssuePatch …
  storage.ts        the core: read/write issues, allocateId, createIssue,
                    updateIssue, state transitions, activity log. Markdown +
                    YAML frontmatter via gray-matter; validated with zod.
  query.ts          listing / filtering helpers
  registry.ts       workspace registry (prefix → root) across repos
  cross-repo.ts     transfer/link issues between workspaces (verifies dest .hivemind)
  agent-context.ts  writes CLAUDE.md / agent context files
  templates.ts      issue + workspace scaffolding templates
  index.ts          barrel
```

Sub-path exports are explicit (`@hivemind/core/types`, `/storage`, `/registry`,
`/cross-repo`, …) — import from the specific sub-path, not the barrel, in hot
paths.

## Data model

Each issue is one markdown file `.hivemind/issues/<PREFIX>-<n>.md` with YAML
frontmatter (id, state, assignee, labels, parent, links, timestamps) + body
sections (description, acceptance criteria, activity log). **The file is the
single source of truth** — there is no DB. The UI watches the filesystem and
re-reads.

## Invariants — do not break

- **`allocateId` is mutex-guarded** (async lock over the per-prefix counter in
  `config.yaml`). Concurrent `createIssue` calls must not collide. Keep new write
  paths going through it.
- **State changes append to the activity log** with `who`/`note`; don't mutate
  state without recording provenance.
- **`cross-repo` transfer verifies the destination has a `.hivemind/`** before
  writing (guards against leaking issues into an unrelated repo).
- Writes are the canonical path for both CLI and desktop — when adding a field,
  thread it through `IssuePatch` (in `types.ts`) + `updateIssue`, not a one-off.

## Tests

`storage.test.ts` + `cross-repo.test.ts` (node:test) pin the read/write/migrate
and transfer semantics. Run with `pnpm --filter @hivemind/core test` (or the
desktop `test:unit` which imports core). Add a test for any new write path or
schema change.
