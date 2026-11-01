# The phone looks like the computer (2026-11-01)

Status: building. The phone page (`crates/hive-web`) takes the computer's theme, background and
live wallpaper. The Android and iOS apps are not part of this round.

## Data

- **What is sent:** Home (spec/home.md 0.5) carries `look`: the mode, every palette token and the
  accent as `#rrggbb`, the terminal's colours, and the wallpaper as the computer shows it: `kind`
  (`none` when the computer draws none), `colour`, `brightness`, `motion`, `glass` (the panel
  tint, or null), and for a photo or video `media: {revision, type}`. The revision is a hash of the
  file's address, never the address.
- **Who owns it:** the computer's settings. `PeerLinks` works it out (`homeLook`) when the
  settings change, and Home sends it whole in the first answer and again only when it changed
  (`lookStale`), never with each row or line.
- **Files:** two workspace API calls, the owner's alone (not named in `roles.ts`), allowed to a
  phone (`PHONE_MAY`). `appearance.media(revision, offset)` gives the photo or video in 1 MiB
  pieces; `appearance.wallpaperFile(path)` gives a file of the live wallpaper chosen now, as
  `view.file` gives a view's, under the same policy.

## Sizes, measured

| What | Size | Calls |
|---|---|---|
| A photo picked on this computer (1200×1920 JPEG) | 544 KB | 1 |
| A video picked here (WebM) / (MOV) | 3.9 MB / 38.7 MB | 4 / 39 |
| Koi Pond (`@dip497/live-scenes/koi`): entry, SDK, font | 49 KB + SDK + 22 KB | 4 |

A photo is sent as it is. A 390×844 phone at 3× is 1170×2532 device pixels; a landscape photo
cover-fit there is drawn 2532 px tall, so a 4032×3024 camera photo is already drawn at 0.84× and a
1920×1080 one is enlarged. Any smaller copy would be softer than the desktop's, so none is made.

## On the phone

- Kept in the page's Cache Storage under the revision, one at a time: a reload or a reconnection
  shows it without asking again; a new revision replaces it.
- A live wallpaper runs as a view does on the phone: in a frame on the views' origin, its files
  through the shell's service worker, under the computer's policy (`default-src 'none'`,
  `connect-src 'none'`), inert, out of the keyboard's way, and checked by the desktop's own
  `WallpaperLink` (protocol 1, message rate, malformed messages). A view and a live wallpaper never
  run at once: while a view is shown, the wallpaper is gone.
- Cost: viewport pixel ratio at most 2, `mode: still` with `prefers-reduced-motion`, `hold` while
  the page is hidden, the SDK's 30 frames a second at most. The page takes the frame away once it
  is hidden for 30 s.
- Readability: the desktop's rules. Cards (rows) take the widget card's 97% tint, bars the Layers
  panel's clamp(68%, tint, 92%) with the blur, and with reduced transparency or more contrast both
  are solid. A photo or video gets the desktop's brightness layer and vignette. Terminal and
  conversation screens stay solid.

## Guest rule

Home and the two calls are the owner's: a guest's device is refused them, as a desktop guest is
never sent a photo, video or package (`sharedAppearance`). A guest's phone shows its own
computer's look, which holds nothing of the host's but what `appearance.get` gives.

## Ceilings

- A file over 96 MiB is not sent; the phone shows the scene the desktop falls back to.
- A video the phone cannot decode (HEVC on Android) falls back to Aurora, as on the desktop.
- On the phone the live wallpaper's frame is same-origin with its shell on the views' origin (a
  service worker cannot serve an opaque-origin frame), where the desktop gives it an opaque origin.
  The origin is wiped before it starts and holds nothing of the page's.
- The CPU watchdog (60% of a core for 6 s) is the desktop's main process; a browser page cannot
  measure a frame's CPU, so the phone has only the frame cap and the 30 s hidden rule.
- Not measured on a real phone or GPU.
