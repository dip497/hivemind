# Live wallpapers anyone can make — design (2026-10-29)

Status: shipped in 2026.10.8 as live wallpaper protocol 1; **protocol 1 and the agent-driven
design below are superseded** by the ambient redesign and live wallpaper protocol 2 (next
section). The package member, the sandbox, the clock, `startup.wallpaper` and most of the security
review still hold, as marked. Follows the built-in live scenes (Shoal, Koi Pond, Jellyfish,
Fireflies, `apps/desktop/src/renderer/src/live/`).

## Changed: an ambient world, live wallpaper protocol 2 (2026-10-29)

The maintainer found the released live wallpapers over-engineered and replaced them.

**What changed**

- **No agents, no tiles.** A live wallpaper (the four built-in scenes and a package's own) is an
  ambient world whose life moves on its own and plays with the pointer: the pointer over empty
  canvas, and clicks there (a ripple, food for the koi, a scatter). It makes no creature per
  agent, moves nothing by an agent's status, sends nothing to a tile, keeps nothing out from
  under tiles, names nothing on hover and opens nothing on click.
- **No Colour switch.** `appearance.wallpaper.colour` and the manifest's `colour` are removed. A
  live scene is always drawn in its own colours, a light or a dark version by the theme's page
  colour (`live/palette.ts` `lightOf`).
- **Live scenes keep moving while the window is idle.** They hold only when the window is hidden,
  unfocused or covered (Settings, a fullscreen tile); a video and a photo's pan still pause when
  idle (`apps/desktop/src/renderer/src/Wallpaper.tsx`).
- **Protocol 2** (`packages/hive-view-sdk/src/wallpaper.ts`, `wallpaper-client.ts`,
  `wallpaper-testing.ts`; host side `packages/view-host/src/wallpaper-link.ts`; app side
  `apps/desktop/src/renderer/src/live/plugin-engine.ts`). Host → wallpaper: `hello {protocol,
  viewport, look {page, text, dark, mono}, mode}`, `viewport {w, h, dpr}`, `look`, `mode
  {run|hold|still}`, `pointer {x, y, over}`, `click {x, y}`. Wallpaper → host: `ready {protocol}`
  and `drawn` only, each with its own keys and no others. The SDK: `connectWallpaper()`,
  `on("viewport"|"look"|"mode"|"pointer"|"click")`, `animate({step, draw, settle?}, {fps})`,
  `drawn()`; `fakeWallpaperHost()` with `point`, `click`, `send`, `received`, `refused`, `drawn`.
  Removed: creatures, tiles, `seeThrough`, `done`, `hover`, `hitTest`, `wallpaperRefusal`,
  `AgentState` / `CREATURE_STATES`, `MAX_WALLPAPER_*`, `look.attention`, `look.colour`.
- **Protocol 1 is refused.** A manifest of protocol 1 is refused at install and by `hive plugins
  check` ("it speaks live wallpaper protocol 1, which this Hivemind no longer does: build it again
  with the SDK this app serves, and set "protocol" to 2"). HiveHub lists a package holding a
  wallpaper as needing Hivemind 2026.10.9 (`packages/hive-hub/src/since.ts`).
- **The starter** (`hive plugins new wallpaper`, `apps/cli/src/wallpaper-starter.ts`) is ambient:
  glyph fish that wander and shy from the pointer, ripples on click. Its brief
  (`apps/cli/src/plugin-brief.ts`) and draw check (`apps/cli/src/check/wallpaper-draw.ts`) follow.

**Why**

- A background that echoes each agent's state says again what the tile, the bell and Layers
  already say, and it made the wallpaper a second, weaker status display to keep correct.
- It was most of the cost and most of the surface: a creature roster per status change, tile boxes
  once a second and at most once a frame while the canvas moved, a hit test on every pointer move,
  a label drawn over the scene, and the code that kept creatures off tiles and walked them to a
  tile when their agent needed you.
- It was most of the risk: three of the security findings below (a click the wallpaper chooses,
  handles for tiles, hover traffic) existed only because the wallpaper knew the workspace. Told
  nothing of it, a wallpaper has nothing of the person's work to leak and nothing to steer.

**Still true**

The sandbox (opaque origin, no fetch or loading, no permissions), the keyboard guard (a wallpaper
that takes the keyboard is turned off and focus goes back), turning it off for 8 malformed
messages, more than 120 a second, a newer protocol, or 60% of a core for six seconds,
`startup.wallpaper` offered once after install, previews read as PNG, JPEG or WebP by their bytes
and only for a package that is on, not drawn behind a plugin view or on the phone page, and
WebRTC still open (see the security review).

**Cost per event, now.** The host sends `viewport`, `look` and `mode` only when they change, never
the same thing twice; the pointer at most once a frame and only while it is over empty canvas (and
once as it leaves); a click per press there; nothing while held. Nothing is sent per agent, per
status change or per tile move, and there is no hit test.

---

The rest of this note is the protocol 1 design as it shipped in 2026.10.8, kept for its reasoning.

## The ask (protocol 1)

Someone wants a background of their own whose creatures are their agents, as Shoal's sharks are.
They want their coding agent to build it from an idea, to share it on HiveHub, and to ship it with
a view of theirs, switched on the way Archipelago offers its view after install. And the creatures
should answer the pointer, not only the water.

## Verdict

As decided for protocol 1. Superseded above: **What it is told**, **Interaction**, and the
check's "answers a click" in **Building one**.

| Question | Decision |
|---|---|
| What is it | A new **package member**, `wallpaper` (a live wallpaper), the way a theme is one: it ships in a package, its id is `@owner/package/<folder>`, its package's switch turns it on and off. Not a plugin of its own on HiveHub, so no new tab, catalog type or per-plugin switch: a wallpaper is never useful alone, and a package is already the unit that is published, reviewed, installed, updated and rolled back. |
| Where it runs | A sandboxed iframe in the wallpaper layer, served over `hm-view:` like a view: an opaque origin, `default-src 'none'`, no network, no permissions, its own process. Its drawing never runs on the window's main thread, where terminals draw. |
| What it is told | Less than a view: each agent's creature (an opaque id, the program, its state), where the tiles are on the screen, the colours, whether to run, hold or show one still frame, the pointer and clicks over empty canvas, and a turn that ended well. Never a name, a folder, a command or anything a terminal shows. |
| How it is picked | `appearance.wallpaper.kind` takes its id. Settings ▸ Appearance lists installed ones after the built-in scenes. `hive config set appearance.wallpaper.kind '"@me/pond/pond"'` does the same. |
| Shipped with a view | A package's `startup.wallpaper` names one of its wallpapers. The app offers it once after install, in the same offer as `startup.view` ("Bees is installed. Use its wallpaper?"), and never switches without the person. |
| Interaction | Every scene, built in or not, answers which creature is at a point. Hovering one shows its agent's name and state (drawn by the app); clicking one goes to its agent's tile. A click on open water stays the scene's. |
| Behind a plugin view, on the phone | Not drawn, as the built-in scenes are not: a view lays its tiles out itself, so the host does not know where they are, and the phone draws no wallpaper. |
| Building one | `hive plugins new wallpaper <name>` starts a package holding a working wallpaper with a PROMPT.md carrying the whole guide; `hive plugins check` loads it against a fake host and checks it draws, answers a click and stops when held. The repo skill `hivemind-live-wallpaper` says the same for contributors. |

## The contract: wallpaper protocol 1 (superseded by protocol 2)

One MessagePort, handed over with the view handshake (`hivemind-view:port`); JSON messages with a
`type`, checked on both sides (`packages/hive-view-sdk/src/wallpaper.ts`).

Host → wallpaper: `hello` (everything below at once), `viewport {w,h,dpr}`, `look {page, text,
attention, dark, colour, mono}`, `mode {run|hold|still}`, `creatures [{id, agent, kind, size,
state}]` with state `working | ready | needs-you | resting`, `tiles {tiles [{x0,y0,x1,y1,id?}],
seeThrough}`, `done {id}`, `pointer {x,y,over}`, `click {x,y,id}` (the creature the click opened,
or null).

Wallpaper → host: `drawn` (its first frame is up: the host shows the layer), `hover {id|null}`
(the creature under the pointer, when that changes).

A click opens the creature the wallpaper last said is under the pointer, whose agent's name the app
shows there: the wallpaper never answers a click, so nothing it sends can move the canvas without
the person clicking where they were shown a name. The host takes `hover` only for an id it sent.
Malformed traffic, more than 120 messages a second or 60% of a core for six
seconds (the views' watchdog) turns the wallpaper off for the session, with a notice; the plain
background shows instead.

The SDK's `connectWallpaper()` gives the values and their changes, `hitTest(fn)` (it answers the
pointer from it), and `animate({step, draw, settle})`: the clock the built-in scenes
run on, moved into the SDK so both keep the same rules (at most 30 frames a second, nothing while
held, one settled frame when motion is off).

## Cost per event (protocol 1, superseded)

What the host does is the built-in scenes' feed, unchanged: the creatures again only when one comes,
goes or changes state (keyed on the roster); tile boxes once a second while running and at most once
a frame while the canvas moves; the pointer at most once a frame while it is over empty canvas.
Each goes to one port. Hit-testing is the scene's: a few distance checks per creature (8 at most).

## Security review (2026-10-29)

An independent review of the branch found these; each is fixed where it lives, with a test that
fails without the fix unless said.

Since protocol 2: **no longer apply**, because the feature they guarded is gone: a click it
chooses (hover-to-click) and what it is told (handles for creatures and tiles); the hover half of
what it says. **Still apply**: the keyboard, its origin, its preview, every window told when a
package is switched off, the handshake, its own keys on `ready` and `drawn`, and WebRTC.

- **The keyboard** (still applies). A cross-origin frame can focus itself without the person doing anything, and
  `inert` does not stop it. `PluginEngine` watches the window's `blur`: when focus went to the
  wallpaper's frame, the frame is removed, what had focus gets it back and the wallpaper is off for
  the session. Keys typed in the moment before are lost to it.
- **A click it chooses** (no longer applies: protocol 2 has no hover and a click opens nothing). A `hover` counts only while the pointer is over empty canvas (it was taken
  at any time and stuck), is cleared as the pointer leaves the water, and the name goes with the
  pointer, so a click opens only the agent named where the person clicks.
- **What it is told** (no longer applies: protocol 2 sends no creatures or tiles). A creature and its tile carry a random handle for the session, not the tile's
  id (which said its kind and when it was made); tiles with no creature carry none.
- **What it says** (still applies to `ready` and `drawn`; protocol 2 has no hover). Messages carry their own keys and nothing else, and a refusal quotes what it
  sent at most 40 characters long, controls and bidi characters escaped (the view protocol too).
  Hover is taken at most once a frame.
- **Its origin** (still applies). A wallpaper's host is looked up before a view's, so a view a repository ships
  named `wp-<hash>` cannot take a wallpaper's origin.
- **Its preview** (still applies). Read and decoded only for a package that is on, and only a PNG, JPEG or WebP by
  its bytes; `hive plugins check` and install refuse another. HiveHub reads no preview bytes, so it
  does not refuse one yet.
- **Switched off** (still applies). Every window hears that a package changed (`wallpapers:changed`), so a wallpaper
  switched off in one window stops in the others.
- **The handshake** (still applies) is taken only from the parent frame when the page is framed (hardening: no
  other frame shares a wallpaper's page today; no test).

Open, and still: **WebRTC.** The frame's CSP stops `fetch` and loading, but no page policy Chromium has stops
`RTCPeerConnection`. Measured in this app's Electron: the window's
`setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` stops STUN over UDP but not TURN over TCP,
and a CSP `webrtc` directive is ignored. Under protocol 1 a wallpaper could send what it was told
(programs, states, tile layout, the pointer) and the computer's address to a server; under
protocol 2 what it is told is its size, the theme's colours and font, whether the window is in
use, and the pointer, with the computer's address. Views share it, as the phone
design already says (§11). Closing it needs isolation outside the page (a session of its own whose
WebRTC goes through a proxy that refuses, or the scene in a worker, which has no
`RTCPeerConnection`); the guide says to install wallpapers, like views, from people you trust.

## Not now

- A theme naming a live wallpaper (`theme.json` reserves `scene`): an app without the wallpaper
  refuses the whole theme; a package's `startup.wallpaper` covers the case.
- A wallpaper of its own on HiveHub, outside a package.
- Wallpapers behind plugin views: a view would have to say where its tiles are.
