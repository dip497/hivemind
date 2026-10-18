# Demo media: the website's clips, recorded from the real app

**Goal.** The home page shows what Hivemind does in short silent loops, each one idea, each
recorded from the real app. The hero (20–30 s) opens on a board of real agents on real jobs:
one documents ripgrep's glob flags, one writes fastapi docstrings, one reviews an excalidraw
branch, one waits on you and you answer it; then one agent is typed one line, builds a widget,
installs it and ticks it off. The feature clips (8–15 s): widgets, tools, views, machines,
devices, join, phone. One command makes them again.

**The rule it keeps.** `demo-scene-2026-09-18.md`: only real output from the real app. Every
tile on screen is a real agent. The renderer moves a camera and a pointer over captured frames
and writes a caption under the window. It draws no interface, and it shows nothing the app
cannot do: a widget is installed with `hive widgets install`, because plugins do not load
themselves.

**The look.** Flat: the app's own background (`#0d0e10`), the window flat with no tilt, glow or
gradient behind it. The real canvas is on screen within 3 s, one continuous camera move per clip,
at most one hard cut. One short sentence per caption in Geist, labels and commands in JetBrains
Mono, fading over 180 ms; 36 px captions, so they still read when the page shows the clip 600 px wide. Real speed, except a marked skip shown as a plain `+40 s`. The end card
is the name and the install command, held 2.5 s.

## The demo workspace

`apps/desktop/scripts/demo-media/demo-workspace.sh` builds it from nothing in `/tmp/hivemind-demo`
(outside any home folder, so no path on screen names whoever ran it):

| Project | Licence | Pinned at |
|---|---|---|
| excalidraw (TypeScript) | MIT | `4c37956b` |
| ripgrep (Rust) | Unlicense or MIT | `3fce3b5b` |
| fastapi (Python) | MIT | `b23d78f2` |

Each is a hivemind workspace (`hive init`: the issue tracker and the agent instructions) with
issues written as Markdown (`hive new`). `fix/arrow-binding` (excalidraw) and `docs/glob-order`
(ripgrep) are branches in their own worktrees, with real edits under way. Fixed commit dates make
the same commits every time.

## Agents: which are real

All of them. Every tile is Claude Code, on the login of whoever records, with their settings,
hooks, plugins, MCP servers and CLAUDE.md files kept out (`--setting-sources project,local`,
`--strict-mcp-config`, `claudeMdExcludes`), its git identity replaced and its permission mode
`default`. It may run, without asking, only `hive` and commands that read (`ls`, `cat`, `head`,
`mkdir`, `rg`, `grep`, `git status|diff|log`, `ruff check`); a builder may also accept edits.
Anything else asks, and the person answers in the tile or from the paired phone, as a person
would; the camera holds long enough to read the ask and the answer. The run fails if anything of
the demo lands in the runner's `~/.claude` settings, CLAUDE.md or `~/.gitconfig`. Claude Code
still records its sessions and the demo folders it was trusted in under the runner's `~/.claude`
and `~/.claude.json`, as any session does.

Every Electron, xvfb and render runs under `nice -n 15`, one capture at a time.

## Pipeline

```
demo-workspace.sh   →  /tmp/hivemind-demo
capture.spec.ts     →  ~/hivemind-demo-recording/frames/*.png + cues.json   (the hero and phone)
clips.spec.ts       →  ~/hivemind-demo-recording/<clip>/…                    (one test per clip)
render/render.mjs   →  site/public/shots/<clip>/clip.webm, clip.mp4, poster.webp
                       + review/<clip>-contact.webp and stills beside the recording
```

1. **Capture**: the built app under xvfb with its own profile, network and paired phone page (the
   e2e helpers). Frames come from `webContents.capturePage()` at 2x, each with the time it was
   taken. The machine is named `studio` (a `gethostname` shim) and no update is offered. It
   records whole beats: the board, the close-up, each typed word, the agent's whole build as a
   time-lapse, the board after; then the phone's ask and answer.
2. **Cues** (`cues.json`): what capture saw, as data: each beat's frames and times, the boxes the
   camera aims at, the scene counted by `hive ctl agents` and the widget's own `list`.
3. **Story** (`story.json`): what each clip shows when: beats, camera keys by box name, captions,
   phone and pointer. Copy or timing changes never need a new recording. A box the recording did
   not measure (a widget floating over the board, before capture measured those) may be given in
   the story's own `boxes`, measured from the frames. A caption
   stays at least 0.3 s a word once it is in; the render refuses one that does not.
4. **Render**: a Remotion composition (`render/src/Clip.tsx`) whose frame `f` is a pure function
   of story, cues and frames, on a flat background. Geist and JetBrains Mono come from
   `@remotion/google-fonts` (both SIL OFL). Frames go to ffmpeg once per
   format with bit-exact flags: AV1 in WebM, H.264 in MP4 with faststart, the first frame as the
   WebP poster.
5. **Review**: a contact sheet (a frame every half second) and three stills per clip, beside the
   recording, never shipped.

## Budgets

| Output | Budget |
|---|---|
| `poster.webp`, the LCP element | ≤ 120 KB |
| `clip.webm` (AV1), 1280×800, 30 fps | ≤ 1.5 MB |
| `clip.mp4` (H.264) | ≤ 2 MB |
| words on screen at once | ≤ 8 (the render refuses more) |
| caption fades | 150–200 ms; the real canvas within 3 s |

On the page the poster is an `<img fetchpriority="high">` and `site/src/components/Loop.astro` (`name`, `alt`, `eager`, and a `fallback` screenshot until the clip exists)
plays it: the hero's from `load`, the others while on screen; the `<video muted playsinline loop
preload="none">` over it starts after `load` and shows only once it plays. A Pause button is always
there. With `prefers-reduced-motion: reduce` the video does not start; the button can start it.

## Regenerating

```bash
cd apps/desktop && pnpm build                  # the app that is recorded
crates/hive-web/build.sh                       # the phone page (see tools.sh); hive-net built
node scripts/demo-media/demo-media.mjs          # workspace, recording, render
node scripts/demo-media/demo-media.mjs --render # render again from the recording kept
```

It refuses to render when the recording's scene is wrong (fewer than two agents working and one
waiting in the opening, no widget, a widget not ticked off, a widget frame showing `[object `) and prints each output against its budget.
Remotion is used under its free licence (individuals and companies of up to three people).
