# Capture spec

What the README expects, and how to record it. All clips: **1600×1000 window**, dark theme,
no personal repo paths on screen.

## Theme setup (do this once, before any shot)

Open the theme customizer → **Wallpaper → Video** → *Choose video file…* →
`~/Videos/wp-mclaren-1080p.mp4` → click **Cinematic**. That sets glass on, blur 20, panel
tint 0.78, clip brightness 0.55 — the point where the wallpaper still reads as motion but
the panel text stays sharp. Leave **Content glass** off; it makes terminal and diff text
unreadable over a busy clip.

Accent: **Indigo** (the default) for the hero and canvas shots — it's what a first-run user
sees. Don't shoot the README on a custom accent.

### The clip

`mclaren-765lt-spider-blossom-street` (moewalls) — a McLaren under cherry blossom on a neon
street. 24 s, loops cleanly, h264.

**Use the 1080p encode.** The wallpaper plane is window-sized (~1600×1000), so the 4K master
decodes 4× the pixels only to throw them away — no visual gain, real GPU cost, and
`backdrop-filter: blur(20px)` on every glass panel is already the expensive part of that
frame. 4K is not a stability risk; it's a frame-rate one on integrated GPUs.

| File | Size | Use |
|---|---|---|
| `~/Videos/wp-mclaren-1080p.mp4` | 2.8 MB | 1920×1080 h264 — what the app loads |
| `~/Downloads/mclaren-…-moewalls-com.mp4` | 85 MB | 3840×2160 master — keep, don't load |

h264, not HEVC: Chromium ships no H.265 decoder, and `Wallpaper.tsx` falls back to the
aurora gradient on a decode error. If you swap in your own clip, keep it h264.

> **Licensing.** This clip is third-party wallpaper art. Using it on your own desktop is
> one thing; a recording of it in a public MIT README republishes someone else's work on
> the project's front page. Before this README goes public, either clear the rights, or
> swap the wallpaper for footage you own / a CC0 loop and re-shoot `hero.webp` +
> `canvas.png`. Everything else in the shot is ours.

### Asset status

`hero.webp` and `canvas.png` are current — shot against this wallpaper with glass on.
`board.png`, `explorer.png`, `diff.png`, `new-issue.png` are **stale**: they predate the
wallpaper/glass work and show the old opaque theme. Re-shoot them for visual consistency.

Record with `wf-recorder -g "$(slurp)" -f demo.mp4` (Wayland) or `ffmpeg -f x11grab` (X11),
then convert:

```bash
scripts/webp.sh demo.mp4 screenshots/board.webp
```

## Assets

| File | Type | Length | Shot |
|---|---|---|---|
| `hero.webp` | animated | 8–12 s | Click **▶ Work** on an issue → agent tile spawns → it edits → the diff tile fills in live. This is the whole product in one loop. |
| `demo.mp4` | video | 40–90 s | The 60-second tour, with the worktree + remote frame beats. **Not committed** — drag it into a GitHub issue comment, copy the `user-attachments` URL, paste it into the README `<video src>`. |
| `canvas.png` | still | — | Full canvas: board + editor + diff + two agent terminals. |
| `board.webp` | animated | 3–5 s | Drag a card Todo → In progress; the markdown file updates. |
| `explorer.webp` | animated | 3–5 s | Click a file in the tree → it opens in the editor tile. |
| `diff.webp` | animated | 3–5 s | Leave a line comment → send it to the agent. |
| `new-issue.webp` | animated | 3–5 s | Open the new-issue modal, type a title, create. |

## Rules

- **Loop cleanly.** Start and end on the same frame; trim before conversion.
- **No cursor teleports.** Move deliberately; the eye follows the pointer.
- **Under 5 MB each.** GitHub serves them on every README view. `webp.sh` warns past 10 MB.
- **Keep the stills.** `canvas.png` stays a PNG — it's the social-card / npm fallback.
- Alt text lives in the README, not here. Update both if a shot changes.

## Why not a background video

GitHub strips `<style>` from READMEs, so there is no background layer and no custom
fonts. The only motion GitHub renders is an animated `webp`/`gif` from a repo path,
or a `<video>` whose `src` is a `github.com/user-attachments/...` URL. Everything
above is built for those two.
