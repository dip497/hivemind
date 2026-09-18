---
title: Getting started
description: Install Hivemind and start an agent.
---

## Install

Linux x86_64 and macOS Apple Silicon have prebuilt binaries; Intel macs and Linux arm64
build from source with `--dev`. The installer downloads the latest GitHub release:

```bash
bash <(curl -fsSL https://hivemind.griiken.com/install.sh)
```

It installs the `hive` CLI and the `hivemind` app into `~/.hivemind-app/`, symlinks both
into `~/.local/bin/`, and warns if no agent CLI is on `PATH`. Re-run to upgrade; pin a
version with `HIVEMIND_VERSION=v1.0.0`.

## Install an agent CLI

hivemind runs agent CLIs you install yourself. Spawnable today: `claude`, `codex`,
`opencode`, `droid`, `pi`, `kiro`. After installing one, check detection from an
initialised workspace with `hive agent detect`. Capability differences are in
[Agents](../agents/).

## Initialise the workspace

```bash
cd ~/my-project
hive init --prefix MYP
```

Writes `.hivemind/` (the markdown issue tracker) plus the agentic stack: hive skills in
`.claude/skills/` and an agentic section in `CLAUDE.md`. Variants:

```bash
hive init --prefix MYP --no-agentic   # tracker only
hive init                             # refresh the agentic stack in an existing workspace
hive add skill                        # refresh the skills only
```

## Create an issue

```bash
hive new "Fix token expiry comparison" --ac "boundary test || manual check passes"
# → .hivemind/issues/MYP-1.md
```

Each issue is one markdown file with YAML frontmatter; `--ac` seeds the acceptance
checklist. Full command list: [CLI](../cli/).

## Open the canvas

```bash
hivemind .
```

- Number keys `1`–`7` spawn: terminal, agent, explorer, diff, issues, frame, browser.
  `2` spawns the default agent in the selected frame.
- **▶ Work** on an issue card spawns an agent pre-loaded with that issue and the hive
  skills.
- ⌘L toggles the Layers rail (tiles grouped by frame, live agent status).
- ⌘E cycles workspace views; double-click a tile name to rename it.

## What the agent does

The installed skill drives the agent through the execution contract: load the issue
(`hive show MYP-1 --json`), set `in_progress` and claim it, tick criteria with
`hive ctl mark-acceptance`, and end every session with a final `hive ctl set-state`.
Each state change is a markdown write; the board tile updates from filesystem events.
Open a diff tile (`4`) beside the agent to watch edits land, review per-file, and send
line comments back to the agent.

## Where to go next

- [Workspaces](../workspaces/) — frames, worktrees, remote SSH, the tracker layout.
- [Agents](../agents/) — runtimes and what each can do.
- [Agent workflows](../agent-workflows/) — the contract in full; multi-agent control.
- [Views](../views/) and [Appearance](../appearance/) — layout and theming.
- [Troubleshooting](../troubleshooting/) — exit codes and common failures.
