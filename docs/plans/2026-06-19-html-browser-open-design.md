# HTML Files in the Browser Tile

## Decision

HTML preview uses the existing browser tile instead of adding a second renderer
inside the editor. The editor remains the source-editing surface; the browser
tile is the rendering surface.

## Behavior

- `.html` and `.htm` editor tabs show an action to open the file in the browser
  tile for the same frame.
- Terminal links from Codex, Claude, shells, or build tools route `http(s)` URLs
  and local HTML file paths into the in-app browser.
- Non-HTML file paths still use the existing OS/app opener.
- If a browser tile already exists in the frame, the URL opens as a new browser
  tab. Otherwise a browser tile is spawned with that URL.

## Constraints

Local files open as `file://` URLs so relative CSS, images, and scripts resolve
normally. Remote `ssh://` workspaces do not get fake file URLs; remote HTML can
be supported later with a preview bridge or dev server.

## Test Coverage

The pure routing logic is unit-tested in `apps/desktop/tests/unit/browser-open.test.ts`.
The existing browser tile, workbench, and terminal components carry the UI wiring.
