# Painted controls

A community view with controls drawn on a Canvas 2D surface. The view owns their
appearance and placement. The host still owns workspaces and live tool sessions.

```sh
pnpm --filter @hivemind/example-view-painted-controls build
hive views install examples/views/painted-controls/dist
```

Select **Painted controls** in Settings > Views. Previous/Next selects an existing
workspace. Open first tool docks an existing tool from that workspace; Undock returns
it to the host. Before selecting a workspace, Open first tool uses unassigned tools.
No agents or workspaces are created. No extra permissions are requested.

The transparent native buttons match the painted hit regions, so mouse, Tab,
Enter/Space, screen readers, and focus indicators work without a second command
path. Theme changes redraw the canvas. The SDK coalesces redraws and pauses drawing
while hidden; there is no polling or continuous animation. Pixel ratio is capped at 2.

This demonstrates author-defined controls, not a visual toolbar editor. Choose **Settings > Views > Workspace toolbar > Off** to use only the painted
controls. The app Settings button remains available to restore the standard toolbar.
Making the standard toolbar a removable plugin is a separate migration.
