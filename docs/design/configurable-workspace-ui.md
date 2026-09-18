# Configurable workspace UI

Status: registry and custom-controls proofs implemented; Browser opt-in, toolbar Off, and per-view action preferences wired. Remaining tool migrations pending. Performance remains a
release gate; configurability must not remount live tools or add polling.

## What users should achieve

- Build an agent-only workspace, or keep files, diffs, issues, browser, and editor.
- Choose toolbar actions, their order, placement, and whether labels are shown.
- Choose panel visibility, placement, size, tabs, and collapsed state per workspace.
- Configure a view's camera, navigation, background, motion, and quality using
  host-rendered controls declared by that view.
- Save a reusable preset; inspect, change, reset, and export it through the CLI.
- Return to Settings and a working view even with all optional controls hidden.

## Current gaps

The standard toolbar now maps a shared host-action catalog to callbacks, with
per-view action order, visibility, labels, placement and Off. It is still bundled
host presentation, not an installable toolbar contribution. Tool creation also exists in shortcuts, context menus,
file-open flows, and HCP; hiding a button does not disable a tool. TileHost already
preserves live bodies across view changes. Keep that ownership boundary.

## Plugin ownership and defaults

Files, Diff, Issues, Browser, and future tool types belong to optional plugins.
A package may contribute several tools, views, and agent integrations. Installation
does not activate contributions or start work. Fresh installations require explicit
package selection; existing users retain their tools through a one-time migration.
First-party tools must use the same registration/lifecycle contract as community
tools. The core owns workspace/session identity, surface hosting, settings, plugin
management, and recovery. A shell/PTY service is infrastructure; the terminal panel
is a tool contribution.

Namespaced tool IDs prevent one plugin from replacing another tool accidentally.
Metadata discovery must not import renderer code. Only an enabled tool loads its
implementation when opened. Disabling blocks new opens; live instances are retained
until explicitly closed, including a pinned implementation version. Community tool
renderers need an isolation/host-capability boundary before arbitrary executable
plugins can be supported. Metadata registration alone grants no access.

## Separate three concepts

| Control | Meaning | Existing work |
|---|---|---|
| Toolbar customization | Which shortcuts appear, in what order | Unchanged |
| Panel layout/visibility | Where an existing tool is displayed | Parked or restored, never implicitly deleted |
| Tool enablement | Whether new instances may be created | Kept until explicitly closed |

Toolbar choices are preferences, not permissions. True tool disablement must use a
shared availability check across every creation path, including CLI and plugin
requests. It must explain why dependent actions (for example opening an editor from
Files) are unavailable. Agent permissions remain a separate host policy.

## Architecture

Use stable tool IDs and a shared declarative catalog for labels, commands, shortcut
hints, prerequisites, and defaults. Renderer components attach icons and callbacks;
configuration never contains executable code. Views place host-owned tool surfaces.

Keep user defaults, workspace overrides, and transient layout separate. Resolve
preferences once when configuration changes; do not parse schemas or save geometry
on every pointer move. Plugins declare bounded settings schemas. The host supplies
validation, controls, reset, and CLI paths. Unknown tool IDs cannot execute anything.

Settings remains outside the customizable toolbar. Hidden toolbars retain their
existing recovery handle. Empty action lists are valid. Existing settings files keep
the current toolbar until the user explicitly changes it.

## Custom controls can live anywhere in a view

A toolbar is optional presentation, not the command owner. A plugin may paint its
controls in Canvas 2D, SVG, WebGL/Three.js, or DOM, including scene objects and radial
menus. The standard toolbar, custom scene controls, both, or neither are valid user
choices. Authors own rendering and hit testing; the host owns validated commands,
availability and permissions. Merely changing the controls must not change authority.

The current SDK already supports workspace selection and live-surface docking from
sandboxed views. `examples/views/queue` proves that path without a new protocol: its own
list and keys (J/K, N, Enter, Esc) select and dock through SDK commands, and its only
animation stops once it settles. It requests no additional permissions. This is a coded
example, not a visual toolbar authoring application.

The per-view Off preference unmounts the standard toolbar and its handle. Collapsed
uses the existing `hidden` value and retains its handle. App-level Settings stays
visible and keyboard accessible, including when the active view fails. Expansion
is transient and resets when the view or placement changes.

Still missing: the optional default-toolbar plugin, a registry-backed command
availability stream and structured results, and activation enforcement for the
remaining legacy tools. Browser already uses the shared creation gate.

## Delivery order and acceptance

1. **Plugin registry proof (started):** namespaced tool contributions, explicit plugin
   and tool activation, independent per-view visibility/order, stable metadata, no
   execution. Tests distinguish installed, enabled, visible, and unavailable tools.
2. **One optional tool end to end:** migrate Browser into the host registry, plugin
   manager, shared creation gate, lazy implementation, settings/CLI, and legacy
   migration. Preserve an open browser when disabled; reject new opens from all
   supported paths. Show an explicit package choice for a fresh profile.
3. **Catalog-driven toolbar (started):** hide/show/reorder actions in Settings > Views;
   reset independently of placement, empty lists valid, per-view isolation. Remove
   duplicated action definitions from menus and shortcuts.
4. **Remaining first-party tools and layouts:** migrate Files, Diff, Issues, editor,
   and terminal panels; define dependencies. Add workspace layout overrides and
   presets without placing geometry writes in the input path.
5. **View-declared settings:** migrate one built-in view, then community SDK settings;
   quality limits remain host-owned. No arbitrary plugin HTML in Settings.
6. **Portable packages:** preview contributions, settings, missing dependencies, and
   permissions before applying; agent startup still requires separate approval.

The registry proof now backs bundled Browser activation and creation checks. It
does not load third-party tool code. No second package-manifest format is introduced:
the eventual package manifest will contribute this metadata after installation and
compatibility checks.

## Custom-controls verification

`tests/e2e/queue-view.spec.ts` runs Queue with the host toolbar off. Three isolated
Electron cases cover pointer and keyboard docking, preserving the same terminal, the
view's selection becoming the host's, and no additional frames during an idle interval.

A freshly mounted view frame can drop its first input, so the spec presses until the
view's own cursor moves, then checks the host agrees. This demonstrates the
custom-controls contract; it does not establish overall app FPS or complete the
optional tool migration.

## Browser migration (first bundled tool)

Browser is now registered as `hivemind/web/browser` in the bundled `hivemind/web`
plugin. Settings > Extensions exposes its activation. Fresh settings leave it off;
loading a pre-tools version-1 settings file preserves its prior availability.
The Browser component loads only when an existing or new Browser surface mounts.

Toolbar visibility follows activation. Every supported new Browser tile creation
path reaches the renderer's shared creation check, including shortcuts, frame
menus, URL-open fallback, and community view commands. CLI `tool.open` checks the
same core availability resolver in main and rechecks before renderer creation.
Disabling keeps existing tiles and their in-panel navigation/CDP usable. Opening
new tabs inside an existing browser is part of that retained session.

This is an application creation policy, not an OS sandbox or a web-content
permission grant. Downloadable third-party tool implementations, package removal,
and the optional toolbar plugin remain pending. Browser's legacy tile kind stays
as a persistence adapter so existing layouts continue to load.

## Standard toolbar action preferences

`views.toolbars[viewId]` stores `actions` and `labels` independently of placement.
Missing actions follow the catalog; an explicit empty list renders no toolbar or
handle. Missing labels keep the existing icon-only presentation. Reset actions
clears only that view's action preferences and leaves its placement unchanged.
Unknown action IDs are dropped and duplicates appear once.

The catalog is metadata only; `workspace/standard-toolbar.tsx` maps it to existing
host callbacks without importing canvas camera controls. Browser activation still
filters its shortcut independently. Selecting a disabled Browser shortcut does not
enable it; enabling Browser later restores its chosen position. Hiding a shortcut
does not close panels or revoke commands. Updates remain accessible through Settings
when no toolbar is rendered. No polling or continuous animation was added.

The fixed host-action catalog is a migration step. Third-party action registration,
toolbar package lifecycle, and shared command metadata across menus, shortcuts, and
the SDK still need implementation.

Action-preference verification: all three dedicated Electron cases passed (order,
visibility, labels, live-terminal preservation, per-view defaults, CLI persistence,
empty actions, reset independent of placement, and Browser activation separation).
Core tests passed 117/117; desktop units 451/451; desktop build and desktop/CLI
typechecks passed. Default-effects World startup timed out in two wider cases;
all seven host-chrome cases passed with animation disabled in that test profile.
See the recording performance investigation before treating this as release-ready.
