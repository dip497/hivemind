# Hive HQ — example hivemind community view (isometric office)

Every frame is a room with walls in the frame's colour; every tile is a desk whose
monitor glows with the agent's live status (blue idle, green working, amber blocked,
red exited). Loose tiles sit in the lobby. Hover names a desk, click docks its live
terminal on the right, click a room floor selects that frame, drag pans, wheel zooms,
Esc undocks. Pan and zoom are persisted. Pure 2D canvas, draws only on change.

```
pnpm install            # from the repo root (esbuild + @hivemind/view-sdk)
node build.mjs          # → dist/ (index.html, office.js, hivemind-view.json)
hive views install dist # then Settings ▸ View ▸ "Hive HQ" (or ⌘E)
```
