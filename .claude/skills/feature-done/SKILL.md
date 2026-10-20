---
name: feature-done
description: Use before planning, briefing or reporting any user-facing change in hivemind, hivemind-plugins or HiveHub (a feature, a new command, a plugin kind, a data or format change). The definition of done for this open-source project, surface by surface, so nothing ships with the CLI, docs, READMEs, app screens, migrations or HiveHub left behind.
---

# Feature done

Hivemind is an open-source product that people and their agents drive. A change is done when
every surface below that it touches is done, not when the code compiles. The maintainer should
never have to name a missing surface.

## Before you start

Walk the table and write down which rows the change touches. A row that does not apply gets one
word why ("no data change"). Brief every subagent with the rows it owns.

When several agents work at once, give each one the files and contracts it owns (a manifest
field, a schema, a command) and its own worktree and branch. No two agents add the same field,
and no agent moves or merges into another agent's branch. Ready work lands as one combined PR
per round, not one PR per change.

## The surfaces

| # | Surface | Done means |
|---|---|---|
| 1 | **Agent-native CLI** | An agent can do it end to end from `hive` alone: create, check, install, switch on, update, undo, inspect (`--json`, stable exit codes, a `fix` line on refusal). Nothing needs a hand-written file or a click. |
| 2 | **App UI** | The same action exists in the app, in the place users already look, using `components/ui`. Checked in the running app (headless xvfb, isolated HOME) with screenshots of every state, looked at before reporting. |
| 3 | **Phone and browser page** | Says whether the change reaches the phone/web page; if it should, it does. |
| 4 | **Guide** | A page in `site/src/content/guide/` explains it for a user, with real commands. The CLI reference (`guide/(reference)/cli.mdx`) and any API reference list new commands, flags, routes and shapes. One source per fact: link, never repeat. |
| 5 | **Agent briefs** | `PROMPT.md` starters, `hive guide`, and the hivemind skill text in `packages/hive-core/src/templates.ts` say how an agent does it. They say how Hivemind does it and never name or ban an agent's own tools. |
| 6 | **READMEs and package metadata** | Every README it touches names what it is and links its guide page by full URL; no stale command. `homepage`/`repository` in published packages point at the guide. |
| 7 | **HiveHub** | If plugins, ids, kinds or the index change: HiveHub validates, lists and installs it, its site shows it, and `docs/operations.md` in the hub says how to deploy it. Say the deploy order when the app and the hub must change together. |
| 8 | **hivemind-plugins** | Manifests, READMEs and dist match the new rules; its CI passes against main and the release. Merging there publishes, so say when it may merge. |
| 9 | **Local data** | If what is on disk changes, a numbered migration ships in the same release (`packages/hive-core/src/migrations/`), tested on old-shaped data. Users never lose installs, settings or state. |
| 10 | **Contracts and versions** | A changed protocol, manifest, `hive ctl --json` shape or CLI flag bumps its own version and gets a **Breaking:** CHANGELOG line. No shims for older app versions. |
| 11 | **Security** | New input from plugins, peers, the phone or the network is checked at the boundary; secrets by name only; sandboxes hold. Address every security-review finding before reporting. |
| 12 | **Tests** | Behaviour tests at the real boundary pass `.claude/skills/test-audit/SKILL.md`, each shown failing first. Locally run only the test files for what you touched, plus typecheck; CI (about 5 min, on GitHub) runs every suite on the PR, so do not repeat it on the laptop. One focused e2e for a new user flow; the full e2e runs once per round, after merge, and before a release. |
| 13 | **CHANGELOG and release** | One line under `[Unreleased]` in the user's words. Release and installer steps still work (`scripts/install-*-test.sh` when assets or install paths change). |
| 14 | **Cleanup** | Every worktree, shell, monitor, dev server and container you started is closed or listed. Old text, flags and code the change replaces are removed in the same change. |

## Report

End with the table: each row **done** (with where: PR, file, screenshot path), **n/a** (why),
or **open** (what is left and who has it). An open row is said first, not buried.
