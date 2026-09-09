# Settings and extension management

## Decisions

Settings occupies the app window, with persistent navigation and a bounded reading
column. Appearance has one implementation: presets, accent, wallpaper, glass, scene
surfaces, and overlays. Terminal palette and theme import/export are advanced controls.
The toolbar's Theme action opens this page.

Views selects the active renderer and configures the toolbar for that view. Automatic
uses the view's declared position; the user can override it. A matrix of every view's
positions made a simple choice harder to understand.

Extensions owns installation, enable/disable, and removal. Installation uses a native
folder picker followed by a package/permission review. Replacements stage and validate
before replacing the existing package. Load reports update through subscriptions.
There is no marketplace or remote package installer in this change.

## Verified behavior

The focused Electron tests cover installation cancellation, malformed packages,
replacement, disable/enable, removal, toolbar overrides, keyboard focus, theme updates
from the CLI, docked surfaces, and editor/terminal preservation across view switches.
They do not establish performance targets.

Earlier 2026-09-08 validation: desktop typecheck and build pass; 426 unit tests and
25 focused Electron tests pass. Core view-package installation tests: 6 pass.

Latest 2026-09-08 validation after tile reuse and settings serialization: desktop,
core and CLI typechecks pass; desktop build and 445 unit tests pass; 40 targeted
core/CLI tests and 30 focused Electron tests pass. The static docs build also passes.

## Refactor status

The shared TileHost and view contract are useful boundaries. Views can change while
host-owned terminal/editor surfaces stay mounted. A renderer extension is not an
agent-provider extension: providers still use the typed catalog and main-process
adapter. Avoid describing the entire product as dynamically pluggable.

Performance remains a release gate. The existing measurements in
[workspace-views.md](workspace-views.md) show the community dock typing target
(canvas + 5 ms) passing only one of three runs; the other deltas were +9.4 and
+12.2 ms. View-switch long tasks and the undock-to-canvas path also need profiling.
Those results are historical measurements from a loaded software-rendering setup,
not a fresh benchmark of the settings change.

A fresh diagnostic and effects comparison are recorded in
[performance-2026-09-08.md](performance-2026-09-08.md). They confirm that performance
remains open despite the functional gates passing.

The structural-update fix now reuses unchanged `TileSurface` objects in a cache per
workspace. Tests cover callback changes, frame bindings, global scope, editor tabs,
browser requests, and cache removal. This establishes invalidation behavior; it does
not measure frame-time improvement.

Settings persistence now sends ordered path patches, serializes in-flight writes,
preserves pending edits through broadcasts, and reports failed saves with Retry.
Main serializes reads/mutations with publication; core mutations take a cross-process
file lock. Locks time out safely instead of deleting another writer's lock. A crashed
holder requires explicit recovery after confirming the holder is gone.

Next: measure input latency and switching with hardware acceleration, a fixed workload,
and no parallel agent/test workloads. Record percentiles and long tasks, not only
average FPS. Keep the existing canvas baseline. The configuration and provider-plugin
target is in [plugin-configuration.md](plugin-configuration.md); the package inspector
does not implement that target or authorize agent execution.

“Zero lag” is a goal, not a verified property. Do not publish that claim.
