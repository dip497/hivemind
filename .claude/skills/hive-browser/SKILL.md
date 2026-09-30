---
name: hive-browser
description: >-
  Drive a Browser tile on the hivemind canvas from inside an agent session —
  navigate pages, click, fill forms, read content, and screenshot the SAME
  browser tile the user is watching, using the Chrome DevTools Protocol. Use this
  whenever you (an agent running in a hivemind tile) are asked to browse the web,
  open a site, look something up online, log into a page, fill a web form, scrape
  or read a web page, check a dashboard, click around a web app, or take a
  screenshot of a website — anything that needs a real browser. Also use it when
  the user says "open this in the browser", "use the browser tile", "go to
  <url>", "search the web for", or references a Browser tile on their canvas.
  This wraps vercel-labs/agent-browser pointed at the canvas's live browser tile,
  so the user sees every action happen on their screen.
---

# hive-browser

You are an agent running inside a **hivemind** tile (a terminal on an infinite
canvas). The canvas can host **Browser tiles** — real Chromium web views the
user can see. This skill lets you *drive* one of those tiles: same pixels the
user is watching, controlled over the Chrome DevTools Protocol (CDP) using the
[`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI.

You are **not** spawning a hidden headless browser. You attach to the user's
visible tile, act in it, and they watch it happen. That shared context is the
whole point.

## How it works (the mental model)

- Each Browser tile is an Electron `<webview>` with its **own** webContents.
- hivemind exposes a **loopback** CDP port (when enabled) and writes a
  **discovery file** listing the open browser tiles (tile id, frame, URL).
- `agent-browser --cdp <port>` connects to that endpoint; you pick the tab that
  is the user's tile and drive it with `open` / `snapshot` / `click` / `fill` /
  `screenshot`.

## Step 0 — Preconditions (check these first)

Run these and reason about the output before doing anything else:

```bash
# Is the CDP bridge enabled, and where is the discovery file?
echo "targets=$HIVEMIND_BROWSER_TARGETS  port=$HIVEMIND_BROWSER_CDP_PORT"
cat "$HIVEMIND_BROWSER_TARGETS" 2>/dev/null || echo "NO_DISCOVERY_FILE"
```

Interpret:

- **`port=` is empty / `cdpEnabled:false` in the file** → the CDP bridge is
  OFF. It is opt-in for safety (a debug port also exposes the app window). Tell
  the user to enable it: **Settings (gear, top-right) → "Enable agent browser
  control" → Relaunch to apply** (or set `HIVEMIND_BROWSER_CDP=1` in the
  environment before launch). Then retry. Do not try to work around this.
- **`NO_DISCOVERY_FILE` or `tiles: []`** → no Browser tile is open. Ask the user
  to open one (canvas hotkey **`7`**, or a frame's **+ → Browser**), ideally in
  the **same frame** as your tile. Then re-read the file.
- **`tiles:` has entries** → good, continue.

Make sure the `agent-browser` CLI is reachable. Prefer a global install if one
exists; otherwise run it on demand with `npx` — it fetches and caches the native
binary on first use, so there's **no global install and no extra permissions**:

```bash
AB="agent-browser"; command -v agent-browser >/dev/null || AB="npx -y agent-browser"
$AB --version    # sanity check (fetches on first npx run)
```

Use **`$AB`** wherever a command below says `agent-browser`. You do **not** need
to run `agent-browser install` — that downloads a bundled Chrome we don't use;
we attach to the canvas tile over CDP instead. (If `npx` itself is missing, Node
isn't installed — tell the user, since the CLI needs it.)

## Step 1 — Pick the right tile

Read the discovery file. Each entry looks like:

```json
{ "tileId": "tile-browser-1730000000000", "frameId": "frame-...", "url": "https://duckduckgo.com" }
```

- **Exactly one tile** → use it. Easy.
- **Several tiles** → prefer the one in your own frame if you can tell which
  frame you are in; otherwise show the user the list (URLs + frames) and ask
  which one to drive. Never guess silently when it's ambiguous — you might
  hijack a tab the user is using.

Note the chosen tile's **`url`** — you'll use it to identify the live CDP tab.

## Step 2 — Connect and select the tab

`agent-browser` talks to the endpoint; the Electron app exposes **all** its
pages as tabs (your tile's web view *and* the app's own window). List them and
switch to the one whose URL matches your chosen tile:

```bash
$AB connect "$HIVEMIND_BROWSER_CDP_PORT"   # connect once; later commands omit --cdp
$AB tab                                     # list tabs: shows t1/t2… + URLs
$AB tab t<N>                                # switch to YOUR tile's tab (match the URL)
```

(Replace `$AB` with `agent-browser` or `npx -y agent-browser` per Step 0.)

Pick the tab whose URL matches the `url` from Step 1. **Avoid the app-shell
tab** — it's the hivemind UI itself (its URL is a `file://…/index.html` or a
`localhost` dev URL), and driving it would poke the app, not the web. When in
doubt, the web tab is the one with an `http(s)://` URL you recognize.

## Step 3 — Drive it (the agent-browser surface)

Once the right tab is active, this is normal `agent-browser`. Core loop:

```bash
agent-browser open https://example.com          # navigate (aliases: goto, navigate)
agent-browser wait --load networkidle           # let it settle
agent-browser snapshot -i                        # interactive a11y tree with @e1/@e2 refs
agent-browser click @e1                          # click by ref (or a CSS selector)
agent-browser fill @e2 "search text"             # clear + type
agent-browser press Enter
agent-browser snapshot -i                        # re-snapshot after the page changes
```

Reading / extracting:

```bash
agent-browser snapshot --json                    # full tree + refs as JSON
agent-browser get text @e1 --json                # text of one element
```

Seeing the page (great for layout / unlabeled icons / visual state):

```bash
agent-browser screenshot --annotate              # numbered overlay + @e refs you can click next
```

Efficiency — chain or batch so you don't pay per-command startup:

```bash
agent-browser open example.com && agent-browser wait --load networkidle && agent-browser snapshot -i
agent-browser batch "open https://example.com" "snapshot -i" "screenshot"
```

The canonical AI workflow: **open → `snapshot -i` → act on refs → re-snapshot**.
Refs (`@e1`) come from the latest snapshot; re-snapshot whenever the page
changes or you'll act on stale refs.

## Guardrails

- **You are sharing the user's screen.** They see every navigation and click.
  Don't navigate away from something they're mid-task on without saying so.
- **Logins / sensitive sites:** the tile uses a persistent session
  (`persist:browser`), so the user may already be logged in. Don't submit
  credentials, make purchases, or take destructive actions without explicit
  confirmation. agent-browser's `--confirm-actions` and `--allowed-domains`
  flags exist for this — use them when a task touches anything risky.
- **Don't drive the app-shell tab.** It's the hivemind UI. Only act on the web
  tab whose URL matches your chosen Browser tile.
- If a command fails to connect, re-check Step 0 (port enabled? tile open?)
  rather than retrying blindly.

## Quick reference

| You want to… | Command |
|---|---|
| See if browsing is possible | `cat "$HIVEMIND_BROWSER_TARGETS"` |
| Connect | `agent-browser connect "$HIVEMIND_BROWSER_CDP_PORT"` |
| List / pick tab | `agent-browser tab` → `agent-browser tab t<N>` |
| Go to a page | `agent-browser open <url>` |
| See interactive elements | `agent-browser snapshot -i` |
| Click / type | `agent-browser click @e1` · `agent-browser fill @e2 "txt"` |
| Read text | `agent-browser get text @e1 --json` |
| Screenshot | `agent-browser screenshot --annotate` |

Full command surface: `agent-browser --help`, or the README at
https://github.com/vercel-labs/agent-browser.
