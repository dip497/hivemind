---
title: Install and first agent
description: Install Hivemind, add an agent, and start it in a project.
---

Three steps: install the app, add an agent, open a project.

## 1. Install

Linux and macOS:

```bash
bash <(curl -fsSL https://hivemind.griiken.com/install.sh)
```

Windows, in PowerShell:

```powershell
irm https://hivemind.griiken.com/install.ps1 | iex
```

| Platform | You get |
|---|---|
| Linux x86_64, macOS Apple Silicon, Windows x64 | the app, the `hive` CLI and `hive-net` |
| Linux arm64 | the `hive` CLI only, to use as a [machine](../machines/) |
| Intel Mac | build from source with `--dev` |

Files go in `~/.hivemind-app/` (linked into `~/.local/bin/`), or `%LOCALAPPDATA%\hivemind` on
Windows. Run the installer again to upgrade. If the app is open, it downloads the new version and
shows **Restart to finish**.

```bash
bash install.sh --version v2026.10.3   # one exact release
bash install.sh --channel nightly      # nightly builds; --channel stable goes back
bash install.sh --dev                  # build from source (git, node 22+, pnpm, bun)
```

## 2. Add an agent

No agent ships in the app. Install an agent's own CLI (`claude`, `codex`, `opencode`, …), then
start Hivemind: it finds the CLI on your `PATH` and adds the matching agent from
[HiveHub](https://hivehub.griiken.workers.dev/). Or add one yourself:

```bash
hive agents install claude --yes
hive agents list --found          # agents whose CLI is on this machine
```

In the app: **Settings ▸ Plugins**, tab **HiveHub**. More in [Run agents](../agents/).

## 3. Open a project

```bash
cd ~/my-project && hivemind .
```

| Key | Opens |
|---|---|
| `1` | a terminal |
| `2` | your default agent, in the selected frame |
| `3` | the Code tile (files, editor, changes) |
| `6` | a new frame |
| `7` | a browser (once the Browser tool is on in Settings ▸ Plugins) |
| ⌘B (Ctrl+B) | show or hide the Layers panel |
| ⌘E (Ctrl+E) | switch views |

Everything else is in the toolbar's **Add**. Ctrl+click (⌘+click on a Mac) opens a link in a
terminal.

## Next

- Track work as [issues](../issues/) that agents pick up and close.
- Watch an agent's edits and comment on them: [Review changes](../review/).
- Run several agents at once: [Coordinate agents](../agent-workflows/).
