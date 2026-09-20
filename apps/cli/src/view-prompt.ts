/** The brief `hive views new` writes as PROMPT.md: everything an agent needs to build the
 *  view without reading this repository. Kept here, beside the starter, so the two agree. */
export function agentPrompt(id: string, title: string): string {
  return `# Build this view

Hand this file to your coding agent, after writing what you want in **The view I want** below.
Everything it needs is here — it does not need the Hivemind source.

## The view I want

<!-- Replace this with your idea. Be concrete about what you want to SEE:
     "a subway map where each line is a git branch and each stop is a tile"
     "a board with Waiting / Working / Done columns, newest first"
     "a Mars base: one module per agent, a stalled one goes dark"      -->

...

---

## What you are building

A **Hivemind view**: a sandboxed web page that draws the whole workspace. The app hands you a
projection — frames, tiles, names, live status — and you decide how it looks. This is \`${id}\`,
scaffolded in this folder, and it already runs.

You are NOT building a terminal. A tile's terminal is the real one, running in the app; you tell
the app WHERE to put it and it mounts the live surface there (see **Surfaces**).

## The files

- \`src/main.ts\` — your code. Starts with a working example: a list of tiles with status dots.
- \`index.html\` — the page. Your CSS lives here.
- \`hivemind-view.json\` — the manifest: \`id\`, \`name\`, \`version\`, \`entry\`, \`protocol\`, \`permissions\`.
- \`types/view-sdk/\` — the SDK's source, for types only. The app serves the real one at run time;
  never bundle it, never \`npm install\` it. \`build.mjs\` already marks it \`external\`.
- \`build.mjs\` — esbuild → \`dist/\`. \`dist/\` IS the view.

## The loop

\`\`\`bash
npm install
npm run dev     # build + install into the running app
\`\`\`

Then press \`⌘E\` / \`Ctrl+E\` in Hivemind to switch to it. Re-run \`npm run dev\` after each change.
\`npm run typecheck\` type-checks against the real SDK types.

## The API

\`\`\`ts
import { connect, applyThemeVars, statusTone } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);          // theme → CSS custom properties on your document
\`\`\`

**Events** — \`hm.on(type, handler)\`:

| event | payload | meaning |
|---|---|---|
| \`structure\` | \`{ frames, tiles }\` | the workspace changed — redraw |
| \`names\` | \`{ names: Record<id, string> }\` | a tile was renamed |
| \`selection\` | \`{ tileId, frameId, fresh }\` | selection moved |
| \`resize\` | \`{ w, h }\` | your viewport changed |
| \`visibility\` | \`{ visible }\` | your view was shown/hidden — stop animating when hidden |
| \`theme\` | \`{ theme }\` | appearance changed — call \`applyThemeVars\` again |
| \`undock\` | \`{ tileId }\` | the user pulled a tile out of a surface |

\`hm.subscribeStatus(tileId, cb)\` → live status per tile; returns an unsubscribe. \`statusTone(s)\`
maps it to \`working | attention | done | exited | failed | idle\` for colour.

Shapes: \`ViewTile { id, frameId, kind, name }\`, \`ViewFrame\`, and \`hm.hello\` carries
\`{ pluginId, capabilities, theme, layout, viewport, visible }\`.

**Commands** — \`hm.commands.*\`:

| command | needs permission |
|---|---|
| \`selectTile(id)\`, \`selectFrame(id)\`, \`focusTile(id)\` | — |
| \`closeTile(id)\` | \`workspace:close\` |
| \`spawnTile(kind, frameId)\`, \`spawnVis("tree"\\|"shell"\\|"diff"\\|"issues")\`, \`spawnClaude()\`, \`addFrame()\` | \`workspace:spawn\` |

A permission you use must be listed in \`hivemind-view.json\`; the user sees it before installing.
Ask for nothing you don't use.

**Surfaces (the hole-punch)** — how a real terminal appears inside your scene:

\`\`\`ts
hm.setSurfaceRects([{ tileId, x, y, w, h }]);   // px, relative to YOUR viewport
\`\`\`

The host positions the live tile above your iframe at each rect. Send the list whenever your
layout moves; at most 16 rects. \`chrome: "none"\` gives the whole rect to the surface instead of
the host's thin name/status bar. \`hm.onReveal(handler)\` is asked where a tile should appear when
something else focuses it — return a rect, or \`null\` if you can't show it.

**Persistence** — \`hm.setLayout(data)\` stores an opaque blob (≤64 KB) under your view's id; it
comes back as \`hm.hello.layout\`. That is your only storage.

**Animation** — call \`hm.reportFrame()\` on each frame you draw, so the host knows you are
animating. Stop drawing when \`visible\` is false.

**Theme** — style from the CSS variables \`applyThemeVars\` sets: \`--hm-color-*\`, \`--hm-accent\`,
\`--hm-radius\`, \`--hm-font-ui\`, \`--hm-surface\`, \`--hm-status-working|attention|done|exited|failed\`.
Never hardcode colours; the user picks light or dark and an accent.

## The rules of the sandbox

- **No network, no filesystem, no node, no app internals.** \`fetch\`, \`XMLHttpRequest\`, web fonts
  and remote images are blocked by CSP. Everything you ship is in \`dist/\`.
- **One channel.** The only way in or out is the SDK. A view that floods it is disabled for the
  session.
- **A view decides how the workspace LOOKS, never what runs.**
- Keep the page cheap when idle: no rAF loop that runs while hidden, no layout thrash per event.

## Done means

1. \`npm run typecheck\` passes, \`npm run dev\` installs, and the view renders in the app.
2. It redraws correctly on \`structure\`, \`names\`, \`selection\` and \`resize\`, and survives an empty
   workspace (no frames, no tiles) without throwing.
3. Status dots track \`subscribeStatus\`, and colours come from the theme variables in both modes.
4. If it mounts terminals, the surfaces line up with your layout after a resize.
5. \`hivemind-view.json\` lists only the permissions actually used.

Publish when you like it: push the commit, then \`hivehub publish dist\`.
`;
}
