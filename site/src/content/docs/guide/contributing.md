---
title: Contributing
description: Build, test, and contribute to Hivemind.
---

`AGENTS.md` at the repo root (and per package) is the contributor guide. Read the one nearest
the code you change. Summary:

## Layout

```text
apps/desktop            Electron main + preload + React renderer
apps/cli                hive CLI (citty, compiled with bun); hive ctl drives the app
apps/android, apps/ios  phone app sources
packages/hive-core      .hivemind/ storage and parsing (gray-matter + zod), settings, skills
packages/hive-agents    the agent manifest format, its validator and loader
packages/agent-host     agent CLIs in terminals that outlive any window, and their status
packages/agent-sdk      what an agent's hook scripts use to report to the host
packages/host           a workspace's host: the workspace API answered on this machine
packages/workspace-api  the workspace API, over any transport
packages/workspace-doc  a workspace's shared document (Loro)
packages/workspace-host a workspace's shared state, for the app and the headless host
packages/hive-view-sdk  the view protocol, its client and a fake host for tests
packages/view-host      the host end of a view
packages/tile-sdk       the contract a tool plugin's tiles are drawn by
crates/hive-net         the network service (Rust)
crates/hive-phone, hive-web   the phone's core, and the same core in a browser
spec/, conformance/     the agent events and wire protocol, and shared test cases
templates/              the hive-browser skill source
docs/design/            architecture notes (historical; do not rewrite)
```

Agent manifests do not live here: they are in
[dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins) and are published on HiveHub.

pnpm workspace. Node ≥ 22, pnpm 12 (`packageManager` in `package.json` pins the exact version),
bun (CI uses 1.4) for the CLI build and most packages' tests, and Rust (pinned in
`rust-toolchain.toml`) for `crates/`.

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
pnpm test:e2e         # when touching canvas, frame, tile or issue behaviour
```

From the repo root, `pnpm test` runs every package's tests and the CLI's (`bun test`), as CI
does. `cargo test` in `crates/hive-net` runs the network service's tests.

Dev loop: `pnpm --filter @hivemind/desktop run dev` (the app; **Settings ▸ Advanced ▸ In a
browser** serves it to a browser tab too); CLI: `pnpm --filter @hivemind/cli run dev <cmd>`.

Known traps: e2e needs `unset ELECTRON_RUN_AS_NODE` and xvfb; the e2e suite is a gate with
`--retries=0`.

## Conventions

- TypeScript strict; comments explain *why*, matching surrounding density.
- Icons: from `apps/desktop/src/renderer/src/components/icons.tsx` only (Hugeicons, one stroke
  weight); a plugin imports them from `@hivemind/app-ui`. Colours: `var(--color-*)` tokens;
  `--color-fg2` for informational text; `aria-label` on icon-only buttons; focus rings on inputs.
- Agents: a manifest in the plugins repository, not code here (see
  [Add your own agent](../agent-providers/)).
- Commit in logical chunks with explicit paths, never a blind `git add -A`.
- Anything user-facing gets a line under `## [Unreleased]` in `CHANGELOG.md`.

## Design docs

`docs/design/` records why the architecture is as it is (views, agents, remote machines,
multiplayer, the phone). Cite them; write new state in new sections or documents.

## Releases

Release artifacts are built by GitHub Actions. From clean `main`,
`./scripts/release.sh` sets the calendar version (`YYYY.M.N`), writes the changelog, tags,
and pushes; GitHub Actions publishes. Run it only when asked.

## Common entry points

- New agent → `agents/<id>/agent.yaml` in
  [dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins); the format is
  `packages/hive-agents/src/manifest.ts` (`docs/design/agent-providers.md`).
- New view → `hive views new <name>`; it lives in its own repository and is published on HiveHub.
- New widget → `hive widgets new <name>`.
- CLI changes → `apps/cli/src/commands/`; pure argument shaping stays in testable helpers.
- File formats → zod schemas in `packages/hive-core`.
