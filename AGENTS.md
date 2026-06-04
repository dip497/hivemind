# AGENTS.md — hivemind

Guidance for AI agents (and humans) working in this repo. Subfolders have their
own `AGENTS.md` with local detail — read the one nearest the code you're
changing. For the research/knowledge-base workflow, see `CLAUDE.md`.

## What this is

A Linux desktop app (Electron + an infinite [xyflow](https://reactflow.dev)
canvas) that is mission-control for AI coding agents. Every tile is a live
terminal / diff / file-tree / editor / issues board; tiles live in **frames**
(workspaces) bound to a real repo on disk — local, a git worktree, or a remote
SSH host. Issues are plain markdown under `.hivemind/`; agents read/update them
through an MCP server. Local-first, no cloud, no telemetry.

## Monorepo layout

```
apps/
  desktop/   Electron main + preload + React renderer (the canvas app)   → apps/desktop/AGENTS.md
  cli/       `hive` CLI (citty + bun-compile); hosts the MCP server
packages/
  hive-core/ storage + parsing for .hivemind/ (gray-matter + zod)         → packages/hive-core/AGENTS.md
  hive-mcp/  stdio MCP server (tools wrapping hive-core)
  tsconfig/  shared TS config
templates/   per-workspace agentic templates (`hive init --agentic`)
docs/design/ architecture design docs (e.g. remote-frames.md)
scripts/     release.sh + helpers
```

pnpm workspace; Node ≥ 22, pnpm ≥ 10, bun ≥ 1.1 (CLI compile only).

## Build / test / verify (run from `apps/desktop` unless noted)

```bash
pnpm run typecheck      # tsc --noEmit, web + node projects — ALWAYS run before commit
pnpm run build          # electron-vite build (validates the real bundle path)
pnpm test:unit          # node:test — fast, pure logic; add tests here first
pnpm test:e2e           # Playwright + xvfb — needs `unset ELECTRON_RUN_AS_NODE` first
```

The minimum gate before any commit: **typecheck + build + test:unit green.**
Run the relevant e2e when you touch canvas/frame/tile/issue behavior.

## Conventions

- **TypeScript strict.** No `any` escapes without reason.
- **Comments document _why_**, especially load-bearing trade-offs and the
  non-obvious. Match the density of the surrounding file. No restating the code.
- **Icons:** `lucide-react` only — never emoji or unicode glyphs as UI icons
  (they render inconsistently and aren't theme-colorable).
- **Design tokens:** use the `var(--color-*)` palette + the `.u-eyebrow` utility;
  don't hard-code hex. Informational text uses `--color-fg2` (passes WCAG AA);
  `--color-fg3` is decoration only. Add `aria-label` to icon-only buttons and a
  focus ring to every input.
- **Commit messages** end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
  Commit to `main`, in logical chunks. Keep stray files (`.rig/`, scratch) out of
  commits — add explicit paths, don't `git add -A` blindly.
- **CHANGELOG hand-off rule:** anything that ships to users gets a one-line entry
  under `## [Unreleased]` in `CHANGELOG.md` before you hand back.

## Releases

Never build/release locally. `./scripts/release.sh <patch|minor|major>` from a
clean `main` bumps versions, writes the changelog section, tags, and pushes —
GitHub Actions builds + publishes. **Do not run it unless explicitly asked.**

## Gotchas

- The dev-bridge must run under **`tsx` (node), not `bun`** — bun's loader drops
  `@lydell/node-pty` output on Linux.
- e2e: `unset ELECTRON_RUN_AS_NODE` before `playwright`, or Electron starts as
  plain node.
- A persistent PTY daemon survives the window; remote PTYs run in-main (they
  can't survive an ssh drop). See `apps/desktop/AGENTS.md`.
