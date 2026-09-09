# Solar System — example hivemind community view (three.js)

The workspace is a solar system. Every frame is a planet with a procedurally
generated surface (terran, gas giant with rings, desert, ice or lava — picked from the
frame id), an atmosphere tinted with the frame's colour, its own rotation and orbit.
Every tile is a moon around its planet, lit by the agent's live status (blue idle,
green working, amber blocked, red exited). Loose tiles orbit the sun.

Click a planet to fly to it; there its agents live. Click a moon to dock its live
terminal on the right. Esc steps back: undock, then back to the system. Drag orbits,
wheel zooms, the side panel lists planets and moons. Motion runs at a capped 30 fps
while the view is visible, 15 fps with a terminal docked, and stops when hidden or
switched off with the toggle. Camera, focus and motion setting persist.

```
pnpm install            # from the repo root (three + esbuild + @hivemind/view-sdk)
node build.mjs          # → dist/ (index.html, solar.js, hivemind-view.json)
hive views install dist # then Settings ▸ View ▸ "Solar System" (or ⌘E)
```
