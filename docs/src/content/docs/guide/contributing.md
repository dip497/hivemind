---
title: Contributing
description: Build, test, and contribute to Hivemind.
---

`AGENTS.md` at the repo root (and per package) is the authoritative contributor guide —
read the one nearest the code you change. Summary:

## Layout

```text
apps/desktop     Electron main + preload + React renderer
apps/cli         hive CLI (citty + bun-compile); hive ctl is the HCP client
packages/hive-core      .hivemind/ storage + parsing (gray-matter + zod), skills
packages/hive-agents    the agent-provider catalog (one directory per runtime)
packages/hive-view-sdk  community-view protocol + client
templates/              hive-browser skill source
docs/design/            architecture notes (historical; do not rewrite)
```

pnpm workspace; Node ≥ 22, pnpm ≥ 10, bun ≥ 1.1 (CLI compile only).

## Install dependencies

```bash
git clone https://github.com/dip497/hivemind.git
cd hivemind
pnpm install
```

## Gates

From `apps/desktop` unless noted. Minimum before any commit:
**typecheck + build + test:unit green.**

```bash
pnpm run typecheck
pnpm run build
pnpm test:unit        # node:test; add tests here first
pnpm test:e2e         # when touching canvas/frame/tile/issue behaviour
```

Dev loop: `pnpm --filter @hivemind/desktop run dev` (full app) or
`pnpm --filter @hivemind/desktop run dev:bridge -- /path/to/repo` (renderer-only, fastest); CLI:
`pnpm --filter @hivemind/cli run dev <cmd>`.

Known traps: the dev-bridge runs under tsx (node), not bun; e2e needs
`unset ELECTRON_RUN_AS_NODE` and xvfb; the e2e suite is a gate with `retries=0`.

## Conventions

- TypeScript strict; comments explain *why*, matching surrounding density.
- Icons: `lucide-react` only. Colours: `var(--color-*)` tokens; `--color-fg2` for
  informational text; `aria-label` on icon-only buttons; focus rings on inputs.
- Agent providers: one directory in `packages/hive-agents/src/providers/`, registered
  in the shared catalog.
- Commit to `main` in logical chunks with explicit paths — no blind `git add -A`.
- Anything user-facing gets a line under `## [Unreleased]` in `CHANGELOG.md`.

## Design docs

`docs/design/` records why the architecture is as it is (views, providers, remote
frames, approvals). Cite them; write new state in new sections or documents.

## Releases

Release artifacts are built by GitHub Actions. From clean `main`,
`./scripts/release.sh <patch|minor|major>` bumps versions, writes the changelog, tags,
and pushes; GitHub Actions publishes. Run it only when asked.

## Common entry points

- New agent runtime → `packages/hive-agents/src/providers/<id>/`
  (`docs/design/agent-providers.md`).
- New view → `hive views new <name>`; it lives in its own repository and is published on HiveHub.
- CLI changes → `apps/cli/src/commands/`; pure arg shaping stays in testable helpers.
- File formats → zod schemas in `packages/hive-core`.
