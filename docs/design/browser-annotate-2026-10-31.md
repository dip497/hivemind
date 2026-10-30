# Notes on a page: annotating a Browser tile for an agent

Status: built, 2026-10-31 (steps 1–6 below). Two choices differ from the plan:

- Notes are review comments on a page, beside the diff's, in `.hivemind/review.json`. They are not
  a store of their own. So the commands are `hive review` (with `seen`, `dismiss --reason` and
  `--on page|diff` added), not a new `hive ctl notes`.
- The pins are a layer the app adds to the page through DevTools, inside a shadow root. They
  scroll with the page, and the phone sees them in its pictures.

The person points at things on a page in a Browser tile, writes a note on each, and sends the
notes to an agent tile. The agent works through them and marks each one done, dismissed or
answered, and the markers on the page show it.

## What others ship

Codex's browser, Cursor 3 (Design Mode), Conductor (built on Agentation), Lovable, v0, Windsurf
and Stagewise all let a person pin elements or areas with a comment and send them to an agent. The
payload that works is plain text: where the element is, what it says, what it looks like, and the
note. Areas go as a picture. Several notes go in one message.

## Agentation, studied

Agentation 3.1.2 (toolbar) and agentation-mcp 1.3.2 (server), read from their published source
maps. The licence is PolyForm Shield 1.0.0: we learn from it and copy no code.

**Where it runs.** A React toolbar the developer installs into their own page. It patches the
page's own globals (timers, animation frames) to freeze it, and reads React internals for component
names and source lines, which works only in development builds. It calls the page's component
functions to provoke a stack trace, which can run side effects.

**What a note holds.** `element` (a readable name: `button "Save"`, `link to /pricing`),
`elementPath` (up to 4 ancestors by id, first non-generated class or tag, plus `data-testid`-style
attributes), `fullPath`, `nearbyText` (own text plus the neighbours'), `nearbyElements`,
`cssClasses` (module hashes stripped), 31 computed styles with defaults dropped, accessibility
attributes, the bounding box, selected text, the frame chain, React component names and source
file. Plus `intent` (fix, change, question, approve), `severity` (blocking, important,
suggestion), `status` (pending, acknowledged, resolved, dismissed) and a `thread` of human and
agent messages.

**How the person makes one.**
- A click picks the element under the pointer.
- Cmd/Ctrl+click picks several.
- A drag collects the elements inside the box, or saves the area itself.
- Freehand drawing is turned into words: a closed loop is a box or circle, a flat stroke an
  underline, an open one an arrow.
- Numbered markers stay on the page, and P freezes the page.

**How it reaches the agent.**
- Copy as markdown, at four detail levels: compact, standard, detailed, forensic.
- Or sync to a local server on port 4747, which stores the notes in SQLite and serves them over
  HTTP, server-sent events and MCP.
- The MCP `watch_annotations` tool returns at once if notes are pending. Otherwise it waits for
  the first new one, collects for a batch window, then returns. Acknowledging is how the agent
  marks a note as already seen.
- Resolve and dismiss write their summary or reason into the thread.
- The page holds an event stream open, and polls as a backstop, to animate resolved notes away.

**What to avoid from it.**
- Its server has no token, and by default trusts any page from a LAN or `.local` address. Any
  such page can read and write every note.
- The server lives inside whichever agent started first.
- Any client can set any status; no order is enforced.
- A human's reply in a thread never wakes the agent, and the agent is never shown the thread.
- Its selectors are hints, neither checked as unique nor as valid.
- Multi-select keeps the details of the first element only.

**Ideas worth having.**
- Re-find a saved note's element by its box (the element at the box's centre whose size is
  closest), not by selector.
- Pick through transparent overlays by taking every element at the point and preferring one that
  holds its own text.
- Turn drawings into words.
- Show the agent's resolutions live on the markers.
- Tell the person when no agent received their notes.

## Our design

**One owner for the page: the app, through DevTools.** The annotate layer is drawn by the app over
the tile, never injected into the page.
- A click on the layer is turned into page coordinates (the tile's canvas zoom applied).
- `DOM.getNodeForLocation` finds the element, with `ignorePointerEventsNone` to see through
  overlays.
- `Overlay.highlightNode` draws the hover highlight, Chromium's own inspector box.
- `Runtime.callFunctionOn` on that node reads its facts. DevTools runs it outside the page's
  content security policy and without touching its globals.
- `Accessibility.getPartialAXTree` gives the real role and accessible name.
- `DOM.getBoxModel` gives the box, and `Page.captureScreenshot` with a clip gives the picture.
- Freezing uses `Animation.setPlaybackRate(0)` and pauses media through DevTools, never by
  patching the page.

Because picking works from page coordinates in the main process, the same notes work from the
phone and the served browser page, which already send clicks by coordinates (`page-stream.ts`).

**What a note holds.**
- The page URL and the viewport size.
- The element's readable name.
- A selector checked to match exactly one element. It is built from id, test attributes, stable
  classes and `nth-of-type`, and falls back to the path when nothing shorter is unique.
- The element's role and accessible name, its own and nearby text, and its box.
- A cropped screenshot saved as a file.
- The note, and an intent: fix, change or question.

An area note carries the box, the picture and the elements inside it, each with its own details,
not only the first.

**Where notes live.** In the workspace, owned by the main process's workspace store, with a status
lifecycle the store enforces:
- open → seen → done, or open → dismissed;
- dismissing needs a reason;
- only the person reopens a note.

Replies form a thread on the note.

**How they reach the agent.** No server and no port.
- **Send to** picks an agent tile and types the notes into it as one message, through the path
  `hive ctl send` uses.
- The message is markdown: a header with the page and viewport, then each note numbered, with
  its name, selector, role, text, box, picture path and the person's words.
- The agent answers with `hive ctl notes seen|done|dismiss|reply <id>`. The hivemind skill says
  how, and the markers on the page show it at once.
- A reply from the person is typed into that agent too, so the conversation is never one way.

**What it shows.**
- An **Annotate** button in the Browser tile's toolbar.
- Hover highlights the element under the pointer; a click opens a note box.
- Cmd/Ctrl+click picks several elements; a drag picks an area.
- Numbered markers stay on the page, each with its status.
- A list of the page's notes, with **Send to**.

## Build order

1. Picking, in main: page coordinates in, an element's facts out, the selector checked unique. An
   e2e on a fixture page checks the name, selector, role and box for a button, a link, an input,
   an element under a transparent overlay and one with generated class names.
2. The tile's annotate layer: hover highlight, click to note, markers, edit and delete, and
   Cmd/Ctrl+click and drag for several elements or an area. An e2e drives each one.
3. Notes in the workspace store, with the status rules enforced. Unit tests cover every move, and
   check that the refused ones are refused.
4. **Send to** an agent tile, plus `hive ctl notes list|seen|done|dismiss|reply --json`, with exit
   codes and a `fix` line on refusal. An e2e sends two notes to a stand-in agent, which marks one
   done, and the marker shows it.
5. Freeze, through DevTools.
6. Notes from the phone and the served browser page.
7. Later: drawings turned into words, React component and source in development builds (read
   only, never calling components), and cross-origin frames.

## Open questions

- Whether `DOM.getNodeForLocation` returns the right node inside cross-origin iframes, which are
  out of process.
- Whether screenshots belong in the workspace (`.hivemind/notes/`) or in app data. An agent on
  another machine needs to read them.
- Whether notes should become issues when the person wants to keep them.
