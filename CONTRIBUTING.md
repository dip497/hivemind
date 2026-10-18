# Contributing to Hivemind

`AGENTS.md` at the repository root, and the one in each package, is the contributor guide. Read
the one nearest the code you change. This page is the short version.

## Set up

You need git, Node 22 or newer, pnpm 12 (`packageManager` in `package.json` pins the exact
version; `corepack enable` provides it) and bun. For `crates/`, you also need Rust, pinned in
`rust-toolchain.toml`.

```bash
git clone https://github.com/dip497/hivemind.git
cd hivemind
pnpm install
```

To run the app in development:

```bash
pnpm --filter @hivemind/desktop run dev
```

**Settings → Advanced → In a browser** also serves it to a browser tab. To run the CLI from
source: `pnpm --filter @hivemind/cli run dev <command>`.

## Checks before a commit

From `apps/desktop`, these must pass before any commit:

```bash
pnpm run typecheck
pnpm run build
pnpm test:unit        # add tests here first
```

From the repository root, `pnpm test` runs every package's tests and the CLI's, as CI does. In
`crates/hive-net`, `cargo test` runs the network service's tests.

When you change canvas, frame, tile or issue behaviour, also run the end-to-end suite from
`apps/desktop`: `pnpm test:e2e --retries=0`. On Linux it needs `unset ELECTRON_RUN_AS_NODE` and
xvfb, and takes several minutes.

## Where things are

```text
apps/desktop            Electron main + preload + React renderer
apps/cli                the hive CLI (citty, compiled with bun); hive ctl drives the app
apps/android, apps/ios  phone app sources
packages/hive-core      .hivemind/ storage and parsing, settings, skills
packages/hive-agents    the agent manifest format, its validator and loader
packages/agent-host     agent CLIs in terminals that outlive any window, and their status
packages/agent-sdk      what an agent's hook scripts use to report to the app
packages/host           a workspace's host: the workspace API answered on this machine
packages/workspace-api  the workspace API, over any transport
packages/workspace-doc  a workspace's shared document
packages/workspace-host a workspace's shared state, for the app and the headless host
packages/hive-view-sdk  the view protocol, its client and a fake host for tests
packages/view-host      the host end of a view
packages/tile-sdk       the contract a tool plugin's tiles are drawn by
crates/hive-net         the network service (Rust)
crates/hive-phone, hive-web   the phone's core, and the same core in a browser
spec/, conformance/     the agent events and wire protocol, and shared test cases
templates/              the hive-browser skill source
docs/design/            architecture notes
guide/                  the user guide (Mintlify); see guide/AGENTS.md
```

Agents, views, widgets and tools are not in this repository. They live in
[dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins) and are published on
[HiveHub](https://hivehub.griiken.workers.dev/).

## Common entry points

- **A new agent:** `agents/<id>/agent.yaml` in
  [dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins). The format is
  `packages/hive-agents/src/manifest.ts`.
- **A new view:** `hive views new <name>`. **A new widget:** `hive widgets new <name>`. **A new
  tool:** `hive tools new <name>`.
- **CLI changes:** `apps/cli/src/commands/`. Keep argument shaping in helpers you can test.
- **File formats:** zod schemas in `packages/hive-core`.

## Conventions

- TypeScript strict. Comments explain why, matching the code around them.
- Icons come from `apps/desktop/src/renderer/src/components/icons.tsx` only. Colours are
  `var(--color-*)` tokens. Icon-only buttons have an `aria-label`.
- Commit in logical chunks with explicit paths, never a blind `git add -A`.
- Anything users see gets a line under `## [Unreleased]` in `CHANGELOG.md`.
- `docs/design/` records why the architecture is as it is. Cite it, and write new state in new
  sections or documents.

## Releases

GitHub Actions builds and publishes every release. From a clean `main`, `./scripts/release.sh`
sets the calendar version (`YYYY.M.N`), writes the changelog, tags and pushes. Maintainers run
it.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says.
