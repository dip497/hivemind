---
title: Appearance
description: Theme, wallpaper, effects, and settings commands.
---

## Settings

One user-owned file, validated on read and write; a running app applies changes without
a restart:

```text
$XDG_CONFIG_HOME/hivemind/settings.json      # $HIVE_SETTINGS overrides the path
```

Settings opens as a sheet over the workspace: the gear at the toolbar's right end or at the foot
of the Layers panel, or ⌘, (Ctrl+,).

## Appearance page

Choose a preset and accent. Expand **Background** to select wallpaper, or **Overlays**
to add images and videos. Glass controls appear only when glass is enabled.
**Tools in scene views** controls whether docked tools use your theme or an opaque
background. **Advanced** contains terminal colours, theme import, and Copy JSON.

Wallpapers and overlay videos pause while Settings is open.
Closing Settings resumes them without changing your saved preferences.

Additional settings such as fonts and corner radius are available through the CLI or
settings file.

Wallpaper and glass apply under the canvas and Windows views; a community view paints
its own background.

## How Settings is organised

| Group | Pages |
|---|---|
| General | Profile, Appearance, Notifications, Shortcuts |
| Connect | Connect, API access |
| Plugins | Plugins: agents, views, widgets and tools |
| Advanced | In a browser, Servers, About and updates |

Links to the old page names (Agents, Views, Tools, Browse, Installed) open Plugins.

## Plugins

One page for every kind. **Yours** lists what you have, **On HiveHub** what is published on
[HiveHub](https://hivehub.griiken.workers.dev), with one search and a filter by kind. **Add a
view / widget / tool from a folder** adds your own. Installing from HiveHub checks every file
against the checksum HiveHub recorded and shows what the plugin can do before anything is
written. Each plugin has a page with three tabs: **Settings**, **Read me**, **What it can do**.

- **Agents**: point at an agent and **Make default**. Its page says where its CLI was found and
  which version, or how to get it, and sets its launch options (model, permission mode, and
  whatever else it declares); see [Add your own agent](../agent-providers/#launch-options).
- **Views**: **Use** picks the active view. A view's page sets its toolbar under **Display**:
  Automatic, Top, Bottom, Collapsed or Off. **Customize actions** chooses the toolbar's buttons and
  labels; **Reset actions** restores them. Browser shows only while the Browser tool is on.
- **Tools**: a tool you add is off until you switch it on. The Browser's page also holds **Agent
  browser control**, which lets agents drive Browser tiles.

The same from a terminal:

```sh
hive plugins list
hive plugins enable tool:hivemind/web
hive plugins set view:@you/board columns all
hive config set views.chrome.canvas.island '"off"'      # Display: hidden is Collapsed, off is Off
hive config set views.toolbars.canvas.actions '["agent", "board", "theme"]'
```

## Notifications and Shortcuts

Notifications cover agent status transitions while the app is unfocused or another view
is active. On the canvas, `1` opens a terminal, `2` an agent, `3` the Code tile, `6` a frame, `7` a browser.
⌘B (Ctrl+B outside a terminal) shows or hides the Layers panel, ⌘E switches views, Shift+Esc
undocks.

## CLI

```bash
hive config path
hive config get appearance.glass.blur
hive config set appearance.glass.blur 12
hive theme list
hive theme use nord
hive theme export my-theme.json
hive theme import my-theme.json
```

## Environment

- `HIVE_SETTINGS` — alternative settings file.
- `HIVEMIND_SHELL_ENV=0` — tiles inherit the app environment verbatim (CI/e2e).
- `HIVEMIND_BROWSER_CDP_PORT` / `HIVEMIND_BROWSER_TARGETS` — agent-browser bridge, set
  by the app.
