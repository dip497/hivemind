# Orbit — example hivemind community view

Every frame is a sun; its tiles orbit it, coloured by live agent status. Hover names a
tile, click docks its live terminal on the right, click empty space (or Esc) undocks,
the wheel changes the spread (persisted).

```
pnpm install            # from the repo root (esbuild + @hivemind/view-sdk)
node build.mjs          # → dist/ (index.html, orbit.js, hivemind-view.json)
hive views install dist # then ⌘E in the app until "Orbit"
```

`src/main.ts` is the whole plugin (~150 lines): `connect()`, a 2D canvas, one status
subscription per tile, `setSurfaceRects` for the dock, `createInvalidator` so nothing
is drawn while nothing changes.
