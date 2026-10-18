---
title: Settings and appearance
description: Where each setting lives, themes and wallpaper, and the settings file.
---

Open Settings with ⌘, (Ctrl+,), the gear at the toolbar's right end, or the foot of the Layers
panel. Changes apply at once.

## Pages

| Group | Page | Holds |
|---|---|---|
| General | **Profile** | your name and colour |
| | **Appearance** | theme, accent, wallpaper, overlays, glass |
| | **Notifications** | alerts and sounds |
| | **Shortcuts** | keyboard shortcuts |
| Connect | **Connect** | pair devices, let people in ([Connect devices](../connect/)) |
| | **API access** | tokens for programs ([API](../api-tokens/)) |
| Plugins | **Plugins** | agents, views, widgets and tools ([Plugins](../plugins/)) |
| Advanced | **In a browser** | serve the app to a browser tab ([Phone and browser](../phone/#the-whole-app-in-a-browser-tab)) |
| | **Servers** | your network server ([Your own network server](../self-hosting/)) |
| | **About and updates** | version, updates, and whether to check for them |

## Appearance

Pick a preset and an accent. **Background** sets the wallpaper, **Overlays** adds images and
videos, **Advanced** holds terminal colours, theme import and **Copy JSON**. **Tools in scene
views** chooses whether tiles docked in an installed view use your theme or a solid background.
Wallpaper and glass show under Canvas and Windows; an installed view paints its own background.

```bash
hive theme list                # signal (the default), ubuntu, dracula, nord, solarized-dark, one-dark
hive theme use nord
hive theme export my-theme.json
hive theme import my-theme.json
```

## The settings file

Everything is one file you own, checked when it is read and written:

```text
$XDG_CONFIG_HOME/hivemind/settings.json     # $HIVE_SETTINGS names another
```

```bash
hive config path
hive config get appearance.glass.blur
hive config set appearance.glass.blur 12    # a JSON value: '"nord"' for text
```

Fonts and corner radius are set here or with `hive config`, not on a page.

## Environment variables

| Variable | Does |
|---|---|
| `HIVE_SETTINGS` | use another settings file |
| `HIVEMIND_SHELL_ENV=0` | tiles get the app's environment as it is |
| `HIVEMIND_SAFE_MODE=1` | start with no tool plugins loaded |
