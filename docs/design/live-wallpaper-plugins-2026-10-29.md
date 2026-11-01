# Live wallpapers anyone can make — design (2026-10-29)

Status: building. Follows the built-in live scenes (Shoal, Koi Pond, Jellyfish, Fireflies,
`apps/desktop/src/renderer/src/live/`).

## The ask

Someone wants a background of their own whose creatures are their agents, as Shoal's sharks are.
They want their coding agent to build it from an idea, to share it on HiveHub, and to ship it with
a view of theirs, switched on the way Archipelago offers its view after install. And the creatures
should answer the pointer, not only the water.

## Verdict

| Question | Decision |
|---|---|
| What is it | A new **package member**, `wallpaper` (a live wallpaper), the way a theme is one: it ships in a package, its id is `@owner/package/<folder>`, its package's switch turns it on and off. Not a plugin of its own on HiveHub, so no new tab, catalog type or per-plugin switch: a wallpaper is never useful alone, and a package is already the unit that is published, reviewed, installed, updated and rolled back. |
| Where it runs | A sandboxed iframe in the wallpaper layer, served over `hm-view:` like a view: an opaque origin, `default-src 'none'`, no network, no permissions, its own process. Its drawing never runs on the window's main thread, where terminals draw. |
| What it is told | Less than a view: each agent's creature (an opaque id, the program, its state), where the tiles are on the screen, the colours, whether to run, hold or show one still frame, the pointer and clicks over empty canvas, and a turn that ended well. Never a name, a folder, a command or anything a terminal shows. |
| How it is picked | `appearance.wallpaper.kind` takes its id. Settings ▸ Appearance lists installed ones after the built-in scenes. `hive config set appearance.wallpaper.kind '"@me/pond/pond"'` does the same. |
| Shipped with a view | A package's `startup.wallpaper` names one of its wallpapers. The app offers it once after install, in the same offer as `startup.view` ("Bees is installed. Use its wallpaper?"), and never switches without the person. |
| Interaction | Every scene, built in or not, answers which creature is at a point. Hovering one shows its agent's name and state (drawn by the app); clicking one goes to its agent's tile. A click on open water stays the scene's. |
| Behind a plugin view | Not drawn, as the built-in scenes are not: a view lays its tiles out itself, so the host does not know where they are. |
| On the phone | Drawn behind the phone page's screens, on the views' origin (`phone-look-2026-11-01.md`). |
| Building one | `hive plugins new wallpaper <name>` starts a package holding a working wallpaper with a PROMPT.md carrying the whole guide; `hive plugins check` loads it against a fake host and checks it draws, answers a click and stops when held. The repo skill `hivemind-live-wallpaper` says the same for contributors. |

## The contract: wallpaper protocol 1

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

## Cost per event

What the host does is the built-in scenes' feed, unchanged: the creatures again only when one comes,
goes or changes state (keyed on the roster); tile boxes once a second while running and at most once
a frame while the canvas moves; the pointer at most once a frame while it is over empty canvas.
Each goes to one port. Hit-testing is the scene's: a few distance checks per creature (8 at most).

## Security review (2026-10-29)

An independent review of the branch found these; each is fixed where it lives, with a test that
fails without the fix unless said:

- **The keyboard.** A cross-origin frame can focus itself without the person doing anything, and
  `inert` does not stop it. `PluginEngine` watches the window's `blur`: when focus went to the
  wallpaper's frame, the frame is removed, what had focus gets it back and the wallpaper is off for
  the session. Keys typed in the moment before are lost to it.
- **A click it chooses.** A `hover` counts only while the pointer is over empty canvas (it was taken
  at any time and stuck), is cleared as the pointer leaves the water, and the name goes with the
  pointer, so a click opens only the agent named where the person clicks.
- **What it is told.** A creature and its tile carry a random handle for the session, not the tile's
  id (which said its kind and when it was made); tiles with no creature carry none.
- **What it says.** Messages carry their own keys and nothing else, and a refusal quotes what it
  sent at most 40 characters long, controls and bidi characters escaped (the view protocol too).
  Hover is taken at most once a frame.
- **Its origin.** A wallpaper's host is looked up before a view's, so a view a repository ships
  named `wp-<hash>` cannot take a wallpaper's origin.
- **Its preview.** Read and decoded only for a package that is on, and only a PNG, JPEG or WebP by
  its bytes; `hive plugins check` and install refuse another. HiveHub reads no preview bytes, so it
  does not refuse one yet.
- **Switched off.** Every window hears that a package changed (`wallpapers:changed`), so a wallpaper
  switched off in one window stops in the others.
- **The handshake** is taken only from the parent frame when the page is framed (hardening: no
  other frame shares a wallpaper's page today; no test).

Open: **WebRTC.** The frame's CSP stops `fetch` and loading, but no page policy Chromium has stops
`RTCPeerConnection`. Measured in this app's Electron: the window's
`setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` stops STUN over UDP but not TURN over TCP,
and a CSP `webrtc` directive is ignored. A wallpaper could send what it is told (programs, states,
tile layout, the pointer) and the computer's address to a server. Views share it, as the phone
design already says (§11). Closing it needs isolation outside the page (a session of its own whose
WebRTC goes through a proxy that refuses, or the scene in a worker, which has no
`RTCPeerConnection`); the guide says to install wallpapers, like views, from people you trust.

## Not now

- A theme naming a live wallpaper (`theme.json` reserves `scene`): an app without the wallpaper
  refuses the whole theme; a package's `startup.wallpaper` covers the case.
- A wallpaper of its own on HiveHub, outside a package.
- Wallpapers behind plugin views: a view would have to say where its tiles are.
