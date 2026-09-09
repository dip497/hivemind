---
title: Appearance
description: Theme, wallpaper, effects, and settings commands.
---

**Development preview** — the settings.json system and the `hive config` / `hive theme`
commands are on the unreleased development line, as are the Extensions and per-view
toolbar settings described below.

## Settings

One user-owned file, validated on read and write; a running app applies changes without
a restart:

```text
$XDG_CONFIG_HOME/hivemind/settings.json      # $HIVE_SETTINGS overrides the path
```

Full-window Settings opens from the gear. Pages: **Appearance · Views · Extensions ·
Agents · Notifications · Shortcuts · About**.

## Appearance page

Choose a preset and accent. Expand **Background** to select wallpaper, or **Overlays**
to add images and videos. Glass controls appear only when glass is enabled.
**Tools in scene views** controls whether docked tools use your theme or an opaque
background. **Advanced** contains terminal colours, theme import, and Copy JSON.

Wallpapers and overlay videos pause while fullscreen Settings covers the workspace.
Closing Settings resumes them without changing your saved preferences.

Additional settings such as fonts and corner radius are available through the CLI or
settings file.

Wallpaper and glass apply under the canvas and Windows views; World and community
scenes paint their own background.

## Views page

Pick the active view and configure the workspace toolbar **for the current view**
under **Display**: Automatic, Top, Bottom, Collapsed, or Off. Collapsed leaves a
compact handle; Off removes both the toolbar and handle. Custom view controls and
keyboard shortcuts keep working. The app Settings button remains available to
restore the toolbar. Other views keep their own preferences.

Open **Customize actions** to choose shortcuts, move them up or down, or show text
labels. **Reset actions** restores that view's buttons and labels without changing
Display. An empty selection removes the toolbar and its handle. Hiding a shortcut
keeps existing panels open and does not disable the tool. Browser appears only when
enabled under Extensions, even if selected in this list.

The CLI uses `hidden` for Collapsed and `off` for Off:

```sh
hive config set views.chrome.canvas.island '"off"'
hive config set views.chrome.canvas.island '"top"'
hive config set views.toolbars.canvas.actions '["frame", "terminal", "theme"]'
hive config set views.toolbars.canvas.labels true
```

## Extensions page

Install from folder with a review step (manifest, requested permissions, replaced
version; saved layout is kept on replace), then enable, disable, or remove installed
view extensions. Disabled views are skipped at load. The Extensions page reports runtime load problems;
`hive views list` reports package validation errors.

## Agents page

Default agent, model, and permission mode for spawns. Defaults apply only where the
runtime supports them (`--model` needs a provider with a model flag) — see
[Agents](../agents/).

## Notifications and Shortcuts

Notifications cover agent status transitions while the app is unfocused or another view
is active. Shortcuts lists every binding (`1`–`7` spawns, ⌘L layers, ⌘E views,
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
