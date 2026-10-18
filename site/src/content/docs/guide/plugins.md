---
title: Plugins
description: The four kinds of plugin, where each sits, and how to install, make and publish one.
---

Almost everything in Hivemind is a plugin, the app's own parts included. There are four kinds.

<figure class="diagram" style="--min:560px">
  <div><img src="../../diagrams/plugins-kinds.svg" width="700" height="340" alt="A view draws the whole workspace. Inside it sit tiles: an agent tile started from an agent file, a terminal, and a tool tile drawn by a tool plugin. A widget is a small card that floats above every view." /></div>
  <figcaption>Where each kind sits</figcaption>
</figure>

| Kind | What it adds | Runs | Its file | Make one |
|---|---|---|---|---|
| **Agent** | an agent CLI Hivemind can start and read | the CLI, in your terminal | `agent.yaml` | [Add your own agent](../agent-providers/) |
| **View** | a whole new way to draw the workspace | a sandboxed page: no files, no network | `hivemind-view.json` | [Write a view](../extension-authoring/) |
| **Widget** | a small live card over every view | a worker: no files, no network | `widget.json` | [Widgets](../widgets/) |
| **Tool** | a new kind of tile | inside the app, with your access | `hivemind-tool.json` | [Tools](../tool-plugins/) |

## Install

**Settings ▸ Plugins** has two tabs: **Installed** and **HiveHub**. Installing from HiveHub checks
every file against the checksum HiveHub recorded and shows what the plugin may do first. Each
plugin's page has **Settings**, **Read me** and **What it can do**.

```bash
hive plugins list                            # every plugin here, on or off
hive agents install claude                   # or: views, widgets, tools
hive plugins enable tool:dip497/worktrees    # a tool arrives switched off
hive plugins set view:@you/board columns all # a setting the plugin declares
```

A tool runs with your access, so it starts switched off: turn on only the ones you trust. If one
breaks the app, start it with `HIVEMIND_SAFE_MODE=1 hivemind`.

## Make one

```bash
hive views new my-view      # or: hive widgets new, hive tools new
```

Each starter includes `PROMPT.md`, the whole API and its rules in one file. Write what you want at
the top and hand it to a coding agent. **Add → Make your own…** in Settings ▸ Plugins writes that
prompt for you.

## Publish

Give the plugin an id in your own GitHub scope (`@you/name`) and a version, then:

```bash
hivehub publish ./my-plugin
```

A higher version is offered as an update to everyone who has it. A `README.md` beside the manifest
is shown on HiveHub and in Settings. `"category"` (`code`, `git`, `agents`, `productivity`,
`monitoring`, `team`, `web`, `fun` or `other`) groups it in the Add menu and on HiveHub. New agents
are listed by pull request to [dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins).

## Commands agents can run

A view, widget or tool can declare `"commands"` in its manifest and answer them in its code. An
agent lists and runs them while the plugin is open:

```bash
hive ctl plugin commands
hive ctl plugin call dip497/worktrees list
```

## Packages (preview)

`hive packages inspect <dir>` checks a bundle of up to eight views and sixteen agent presets and
shows what it would start. Installing a package is not built yet.
