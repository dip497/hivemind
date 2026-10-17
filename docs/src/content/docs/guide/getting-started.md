---
title: Getting started
description: Install Hivemind and start an agent.
---

## Install

Linux x86_64, macOS Apple Silicon and Windows x64 have prebuilt binaries; Intel macs and
Linux arm64 build from source with `--dev`. The installer downloads the latest GitHub
release:

```bash
bash <(curl -fsSL https://hivemind.griiken.com/install.sh)
```

On Windows, in PowerShell:

```powershell
irm https://hivemind.griiken.com/install.ps1 | iex
```

It installs the `hive` CLI and the `hivemind` app into `~/.hivemind-app/`, symlinks both
into `~/.local/bin/`, and warns if no agent CLI is on `PATH`. Re-run to upgrade; pin a
version with `HIVEMIND_VERSION=v2026.9.0`.

Upgrading while the app is open downloads the new version beside the running one — it cannot
replace a live app — so the last step is yours: Settings ▸ About and updates, or the toolbar, says
**Restart to finish**. Until you do, the version that runs is the old one, and asking again
says it is downloaded already rather than fetching it twice.

## Install an agent CLI

hivemind runs agent CLIs you install yourself. It ships with none: when it starts, it adds
every agent listed on HiveHub whose CLI is on your `PATH` — install `claude`, `codex`,
`amp` or any other, start hivemind, and it appears. After installing one, check
detection from an initialised workspace with `hive agent detect`. Capability differences
are in [Agents](../agents/).

## Track issues (optional)

Open a folder and start an agent; nothing needs setting up first. Issues are the Issues tool's: open
it (Add ▸ Tools ▸ Issues) in a folder that keeps none yet and it offers to keep them there, with the
prefix their ids start with. From a terminal it is:

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

- Keys `1` terminal, `2` agent (the default one, in the selected frame), `3` Code, `6` frame,
  `7` browser. Everything else, Issues included, is in the toolbar's **Add**.
- **▶ work** on an issue card (shown on hover) spawns an agent pre-loaded with that issue and
  the hive skills.
- ⌘B (Ctrl+B outside a terminal) shows or hides the Layers panel: tiles by project, live agent
  status.
- ⌘E cycles workspace views; double-click a tile name to rename it.
- A link in a terminal opens on Ctrl+click (⌘+click on a Mac); a plain click is a click in the
  terminal.

## What the agent does

The installed skill drives the agent through the execution contract: load the issue
(`hive show MYP-1 --json`), set `in_progress` and claim it, tick criteria with
`hive ctl mark-acceptance`, and end every session with a final `hive ctl set-state`.
Each state change is a markdown write; the board tile updates from filesystem events.
Open the Code tile (`3`) beside the agent and switch it to **Changes** to watch edits land,
review per-file, and send line comments back to the agent.
