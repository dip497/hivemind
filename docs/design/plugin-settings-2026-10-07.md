# Plugin settings: one record per plugin, one vocabulary, one page

Status: accepted, built 2026-10-07.

## Context

Hivemind has four kinds of plugin: agents, views, widgets and tools. Before this change each kind
kept its on/off and its options in its own settings.json key, with its own reader and writer:

| Kind | Where it was stored | Who read it |
|---|---|---|
| Agent | `agents.disabled`, `agents.options[id]` | main, `hive host`, the CLI, the spawn path |
| View | `plugins.disabled` | the view registry |
| Tool | `tools.enabledPlugins`, `tools.disabledTools` | the tool registry |
| Widget | nothing (it could not be switched off) | — |

Settings had a sidebar group per kind (Agents, Views, Tools), an overview page for each, a page
per plugin, a Browse page, and an Installed page. A widget, the fifth kind of thing a person
installs, fitted none of them. A plugin's own settings were drawn by hand for each kind; a view
could declare none at all.

## Decision

1. **One record per plugin.** Settings.json has `plugins.state["<kind>:<id>"] = { enabled?, options? }`.
   Absent means "as the plugin is by default": on, except a tool that is not built in.
   `@hivemind/core/plugin-settings` owns the record: parsing (a key whose id cannot be one of its
   kind is dropped), `isPluginEnabled`, `disabledPlugins`, `pluginOptions` and `withPluginState`.
   Every reader uses it: the agent loader, the view registry, the tool registry and the widget
   runtime.
2. **One vocabulary for what a plugin can be set to.** A field is a `boolean`, a `number`
   (`min`, `max`), a `text` (`maxLength`) or a `choice` (`values`, `labels`). It lives in the view
   SDK (`@hivemind/view-sdk/settings`), because plugin authors import that package, and hive-core
   re-exports it.
   - A view declares fields in `hivemind-view.json` `settings` and reads them as `hm.settings`
     (protocol 1.7).
   - A widget's per-placement `options` use the same fields.
   - Agents and tools declare theirs their own way, and core maps those declarations onto fields
     (`agentSettingFields`, `toolSettingFields`).
   - A stored value that no longer fits its field reads as the field's default. A value for a
     field the plugin no longer declares is kept, so going back to the older version finds it.
3. **One Settings page.** Settings ▸ Plugins lists every plugin you have, by kind, or what HiveHub
   has, with one search and one kind filter. Each plugin has one page
   (`plugin:<kind>:<id>`) with three tabs:
   - Settings: the kind's own controls, then the declared fields, drawn by `SettingsForm`;
   - Read me;
   - What it can do.
4. **One CLI.** `hive plugins list | show | enable | disable | set | reset` writes the same
   record inside the settings file lock. It checks each value against its field.
5. **Widgets live beside views.** Widgets are in `~/.config/hivemind/widgets`. The package format
   and the built-ins moved to `@hivemind/core/widget-format` and `@hivemind/core/widgets`, so the
   CLI sees the same widgets as the app.

## Migration

A settings.json with no `plugins.state` is read from the old keys:
- `agents.disabled` becomes agent `enabled: false`;
- `agents.options` becomes agent options;
- `plugins.disabled` becomes view `enabled: false`;
- `tools.enabledPlugins` becomes tool `enabled: true`;
- `tools.disabledTools` `"<plugin>/<tool>"` becomes that tool plugin's option `<tool>: false`.

The first write of the new record copies the file to `settings.json.bak`, once, so a migration
that went wrong can be undone by hand. After that, the record is what counts and the old keys are
not written. A test drives this with a settings.json of the old shape.

## Dropped, and why

- **The Agents, Views and Tools sidebar groups, their overview pages, Browse, and Installed.**
  A sidebar group per kind could not hold a fifth kind. It also put one plugin on two pages: its
  overview row and its own page. What each overview decided is kept as a section of the one page:
  the default agent, the view in use, a tool switched on, and adding agents found on this machine.
  The old page ids still open the right page (`agents` → `plugins`, `agent:claude` →
  `plugin:agent:claude`).
- **`agents.disabled`, `agents.options`, `plugins.disabled` and the `tools` section** as stored
  keys. They are read once for migration, never written. `hive config set tools.enabledPlugins`
  therefore no longer switches a tool on; use `hive plugins enable tool:hivemind/web`. This is
  in the CHANGELOG as **Breaking:**.
- **An `enabledByDefault` manifest field.** Only built-in tools differ from "on", and the tool
  registry already knows which tools are built in. A manifest field would be a second owner of
  that fact.

## Consequences

- A new kind of plugin needs:
  - a key kind in `PLUGIN_KINDS` and an id rule;
  - a section on the Plugins page;
  - a Settings tab body.

  It needs no new settings key and no new CLI.
- `hive host` (a phone's views) does not send view settings yet. A view shown there reads its
  defaults, which the protocol allows. Passing the host's settings is the next step there.
- An app older than this change reads none of the new record, so its agents, views and tools are
  all as by default. The backup keeps the old switches.
