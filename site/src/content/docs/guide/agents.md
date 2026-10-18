---
title: Run agents
description: Install agents, switch them on and off, read their status, and put them to sleep.
---

Every agent is a small file from [HiveHub](https://hivehub.griiken.workers.dev) that tells
Hivemind how to start an agent's CLI and read its screen. You install the CLI; Hivemind adds the
file.

## Install one

| How | Do |
|---|---|
| Automatically | Install the agent's CLI and start Hivemind. It adds every HiveHub agent whose CLI is on your `PATH`, and a notice says what it added (with **Remove**). |
| In the app | **Settings ▸ Plugins** → **HiveHub** → find it → **Install**. |
| In a terminal | `hive agents install codex` shows what it would run; add `--yes` to install. |

```bash
hive agents list --found      # agents whose CLI is on this machine
hive agents remove codex      # removed, and not added again at start
```

To stop automatic adding, switch off **Add agents found on this machine** in Settings ▸ Plugins.
Any coding agent that runs in a terminal works. HiveHub already has files for, among others, aider, amp, claude, cline, codex, copilot, cursor, droid,
kiro, opencode, pi and qwen-code. To write your own: [Add your own agent](../agent-providers/).

## Switch one off, pick the default

Open the agent in **Settings ▸ Plugins**: its switch turns it off (it leaves every menu and
`hive ctl spawn`), **Make default** makes it what ⌘\ and the toolbar's agent button start, and its
launch options set model and permission mode.

```bash
hive plugins disable agent:codex
hive plugins enable agent:codex
```

## Status

A tile shows **working**, **idle** or **needs you**. Status comes from the agent's own reports
where it sends them, and from reading its screen otherwise. It drives the frame header, the Layers
panel and your notifications.

## Agents that can work for other agents

Some agents report when a turn ends. Only those can be workers whose replies another agent
collects ([Coordinate agents](../agent-workflows/)):

| Agent | Gets its task | Resumes | Permission prompts with `--supervise` |
|---|---|---|---|
| claude | as an argument | its own session | go to the supervising agent |
| codex | typed in | newest in the folder | stay with you |
| droid | typed in | newest in the folder | stay with you |
| hermes | typed in | no | stay with you |
| kiro | typed in | its own session | go to the supervising agent |
| opencode | typed in | no | stay with you |
| pi | as an argument | newest in the folder | refused (it has no permission prompts) |

Every other agent runs the same way, but you drive it by hand: a workflow refuses it at once.

## Sleep and resume

Sleeping ends an agent's process to free memory. Its tile keeps its name and conversation and
shows **Resume**.

| Where | Sleep | Wake |
|---|---|---|
| A tile | the moon button in its title bar | **Resume** |
| Layers panel | ⋮ → **Put to sleep** | ⋮ → **Resume** |
| A frame | ⋯ → **Put agents to sleep** | ⋯ → **Resume sleeping agents** |
| Terminal | `hive ctl sleep [tile or frame]` | `hive ctl wake [tile or frame]` |

An agent that is working or waiting on you sleeps only after you confirm (`--force` in the
terminal). A message sent to a sleeping agent waits until it is back at its prompt.

## Assign issues to agents

```bash
hive update MYP-1 --assignee claude --assignee-type agent
```

`.hivemind/.agent.md` sums up the open issues so a new agent session can read one file.
