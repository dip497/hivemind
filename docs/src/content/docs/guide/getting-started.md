---
title: Getting started
description: Install Hivemind and start an agent.
---

## Install

Linux x86_64, macOS Apple Silicon and Windows x64 have prebuilt binaries. Linux arm64 gets
the `hive` CLI alone, to use as a [machine](../machines/). Intel Macs build from source with
`--dev`. The installer downloads the latest GitHub release:

```bash
bash <(curl -fsSL https://hivemind.griiken.com/install.sh)
```

On Windows, in PowerShell:

```powershell
irm https://hivemind.griiken.com/install.ps1 | iex
```

On Linux and macOS it installs the `hive` CLI, `hive-net` and the `hivemind` app into
`~/.hivemind-app/` and links them into `~/.local/bin/`. On Windows they go in
`%LOCALAPPDATA%\hivemind`. At the end it lists the agent CLIs it found on your `PATH`, or warns
that there are none. Re-run it to upgrade. Other choices:

```bash
bash install.sh --version v2026.10.3   # exactly that release, older ones too
bash install.sh --channel nightly      # the newest nightly build; --channel stable goes back
bash install.sh --dev                  # build from source (git, node 22+, pnpm, bun)
```

Upgrading while the app is open downloads the new version beside the running one — it cannot
replace a live app — so the last step is yours: Settings ▸ About and updates, or the toolbar, says
**Restart to finish**. Until you do, the version that runs is the old one, and asking again
says it is downloaded already rather than fetching it twice.

## Install an agent

No agent ships in the app. Agents are plugins listed on
[HiveHub](https://hivehub.griiken.workers.dev/), and Hivemind runs the agent CLIs you install
yourself. When it starts, it adds every agent on HiveHub whose CLI it finds on your `PATH`, and
a notice says what each can do. So: install `claude`, `codex`, `opencode` or another, start
Hivemind, and it appears. This needs the network the first time.

You can also add one by hand, in **Settings ▸ Plugins** (switch the list to **HiveHub**), or from
a terminal:

```bash
hive agents install claude     # its name on HiveHub
hive agents list --found       # the agents installed here whose CLI is on PATH
```

Starting an agent with none installed opens Settings ▸ Plugins. What each agent can do is in
[Agents](../agents/).

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
  `7` browser (once the Browser tool is switched on in Settings ▸ Plugins). Everything else,
  Issues included, is in the toolbar's **Add**.
- **▶ work** on an issue card (shown on hover) starts an agent in that frame with a prompt to
  work on the issue: load it with `hive show`, meet its acceptance criteria, end with
  `hive ctl set-state`.
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

## Next

- [Machines](../machines/): run terminals and agents on another computer over ssh.
- [Multiplayer](../multiplayer/): share a workspace so someone else can join from their computer.
- [Phone](../phone/): follow and answer your agents from your phone.
