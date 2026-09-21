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

Full-window Settings opens from the gear.

## Appearance page

Choose a preset and accent. Expand **Background** to select wallpaper, or **Overlays**
to add images and videos. Glass controls appear only when glass is enabled.
**Tools in scene views** controls whether docked tools use your theme or an opaque
background. **Advanced** contains terminal colours, theme import, and Copy JSON.

Wallpapers and overlay videos pause while fullscreen Settings covers the workspace.
Closing Settings resumes them without changing your saved preferences.

Additional settings such as fonts and corner radius are available through the CLI or
settings file.

Wallpaper and glass apply under the canvas and Windows views; a community view paints
its own background.

## How Settings is organised

The sidebar has **General** (Appearance, Notifications, Shortcuts, About), then one group
per kind of plugin — **Agents**, **Views**, **Tools** — each opening on an overview with a
page for every agent, view and tool, and **Plugins** for browsing and adding more.

## Views

The Views overview picks the active view. Each view's own page configures its toolbar
under **Display**: Automatic, Top, Bottom, Collapsed, or Off. Collapsed leaves a
compact handle; Off removes both the toolbar and handle. Custom view controls and
keyboard shortcuts keep working. The app Settings button remains available to
restore the toolbar. Other views keep their own preferences.

Open **Customize actions** to choose shortcuts, move them up or down, or show text
labels. **Reset actions** restores that view's buttons and labels without changing
Display. An empty selection removes the toolbar and its handle. Hiding a shortcut
keeps existing panels open and does not disable the tool. Browser appears only when
switched on under Tools, even if selected in this list.

The CLI uses `hidden` for Collapsed and `off` for Off:

```sh
hive config set views.chrome.canvas.island '"off"'
hive config set views.chrome.canvas.island '"top"'
hive config set views.toolbars.canvas.actions '["frame", "terminal", "theme"]'
hive config set views.toolbars.canvas.labels true
```

## Plugins

**Browse** lists the agents and views published on
[HiveHub](https://hivehub.griiken.workers.dev), with a checksum for every file. A view is named
`@owner/name` after the GitHub account that published it; an agent has one name, like `gemini`. Installing downloads the files, checks every checksum, and shows
what the plugin can do before anything is written; a file that changed after it was
listed is refused. **Installed** adds a view from a folder (with the same review), and
lists the views and agents you added, with their load problems.

## Agents

The overview picks the default agent and shows which agents this machine has: installed,
not installed, or switched off. Each agent's page says where its CLI was found and which
version it is — or that it is not installed, with a link to get it — and sets its launch
options (model, permission mode, and whatever else it declares), read from the agent's own
CLI; see [Add your own agent](../agent-providers/#launch-options).

## Tools

Switch on optional tools such as Browser. The Browser page also holds **Agent browser
control**, which lets agents drive Browser panels.

## Notifications and Shortcuts

Notifications cover agent status transitions while the app is unfocused or another view
is active. Shortcuts lists every binding (`1`–`7` spawns, ⌘B layers, ⌘E views,
Shift+Esc undock).

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
