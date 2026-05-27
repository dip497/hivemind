# hivemind

> Plane-style project + issue tracker × infinite canvas × Claude Code as a
> first-class collaborator. Local-first. Markdown-backed. No SDK lock-in.

Drop claude (or codex, gemini, opencode) into a real project workspace where
it can read issues, update status, mark acceptance criteria, and comment its
own progress — through the same Model Context Protocol tool surface a human
uses through the `hive` CLI. Drag a file from the tree into the canvas; pin
a diff next to a claude session; drop a "▶ Work on this" prompt that boots
claude into the issue with full context.

## Install (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/dip497/hivemind/main/install.sh | bash
# OR, after cloning:
git clone https://github.com/dip497/hivemind.git && cd hivemind && ./install.sh
```

`install.sh` is idempotent. It will:

1. Verify dependencies — `git`, `node` ≥ 22, `pnpm` ≥ 9, `bun` ≥ 1.1,
   and `claude` CLI on PATH.
2. `pnpm install` the workspace.
3. Build the renderer + the `hive` CLI binary.
4. Symlink `hive` into `~/.local/bin/` (must be on PATH).
5. Print quick-start steps.

If a dep is missing, the script prints the install command for it and exits
non-zero. Re-run after installing.

## Quick Start

```bash
# 1. In any git repo you want to track:
cd ~/my-project
hive init --prefix MYP

# 2. Drop the agentic templates (claude integration) into the workspace:
hive init --agentic     # writes .mcp.json + .claude/skills/hive-work/SKILL.md + CLAUDE.md

# 3. Create an issue:
hive new "Fix token expiry comparison"
# → writes .hivemind/issues/MYP-1.md

# 4. Open the canvas (in a browser):
cd ~/path/to/hivemind/apps/desktop
pnpm run dev:bridge -- ~/my-project       # starts dev-bridge on 127.0.0.1:5180
# then open http://localhost:5180/ in any browser

# 5. From the canvas:
#    - Click MYP-1 → IssuePeek opens
#    - Click "▶ Work on this" → claude spawns with full context, calls
#      mcp__hive__* tools, updates the markdown file as it goes
```

The Electron desktop build is a single `pnpm --filter @hivemind/desktop run build`
(work in progress; the browser path is the recommended way today).

## Architecture

```
.hivemind/
├── issues/      Markdown files, YAML frontmatter. The source of truth.
├── cycles/      Sprint/cycle definitions.
└── config.yaml  Workspace prefix, next id, agent registry.

apps/
├── cli/         The `hive` binary (citty + bun-compile). Also hosts the
│                 MCP server via `hive mcp-stdio`.
└── desktop/     Electron + electron-vite + React renderer.
                 Includes a dev-bridge HTTP shim that lets you drive the UI
                 from a regular browser without packaging Electron.

packages/
├── hive-core/   Storage + parsing (gray-matter + zod schemas).
├── hive-mcp/    9-tool stdio MCP server wrapping hive-core. Used by claude
│                 inside any hivemind workspace via .mcp.json.
└── tsconfig/    Shared TS config.

templates/
└── agentic/     Per-workspace templates copied by `hive init --agentic`:
                 .mcp.json, CLAUDE.md, .claude/skills/hive-work/SKILL.md
```

## How claude talks to hivemind

1. User runs `hive init --agentic` in their repo. This drops `.mcp.json` and
   `CLAUDE.md` and the `hive-work` skill into the workspace.
2. User starts `claude` (in canvas tile or a regular terminal) inside that
   repo.
3. Claude auto-loads `.mcp.json` → spawns `hive mcp-stdio` over stdio →
   gets `mcp__hive__get_issue`, `mcp__hive__set_state`,
   `mcp__hive__add_comment`, `mcp__hive__mark_acceptance`, etc.
4. The skill (`SKILL.md`) auto-activates on any `^[A-Z]+-\d+` mention and
   tells claude to follow the **Execution Contract** — load issue, do work,
   end every session with `mcp__hive__set_state(disposition)`.

Comments and state changes go through the MCP server → the existing
markdown files → instantly visible in the UI (filesystem watcher).

No SDK, no API key. Claude uses your existing `claude` CLI login (Pro /
Max / API). No cloud component, no telemetry.

## Patterns adopted from prior art

| From | Pattern |
|---|---|
| Plane | workspace > project > issue > acceptance criteria + cycles + activity log |
| Multica | CLI-in-PATH as tool surface (multi-runtime); per-task workdir; `agent_run`-style execution record |
| Paperclip | wake-prompt "Execution contract"; 60+ MCP tool surface |
| Superset.sh | shell-env at boot; PTY daemon pattern; pierre/diffs in worker pool |
| Pierre | first-class diff + tree components inside the canvas |
| Unreal Blueprint | comment-box "Frame" nodes to group canvas tiles |

## Development

```bash
pnpm install                                # install everything

# Renderer + dev-bridge (recommended dev loop)
pnpm --filter @hivemind/desktop run dev:bridge -- /path/to/test/repo
# then in another terminal:
pnpm --filter @hivemind/desktop run build    # rebuilds renderer; refresh browser

# CLI
pnpm --filter @hivemind/cli run dev <subcommand>

# Typecheck (web + node)
pnpm --filter @hivemind/desktop run typecheck
```

**Hard rule:** dev-bridge MUST run under `tsx` (node), NOT `bun`. Bun's
loader silently drops `@lydell/node-pty` output on Linux. The dev-bridge
self-guards against accidental bun startup.

## Upgrade

The same `install.sh` upgrades an existing checkout in place — it detects
the `.git/` in `$HIVEMIND_DIR` (default `~/.hivemind-app`), runs
`git pull --ff-only`, refreshes deps, and rebuilds. Safe to re-run anytime:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dip497/hivemind/main/install.sh)
```

## License

[MIT](./LICENSE).
