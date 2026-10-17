# Demo media: the website's clips, recorded from the real app

**Goal.** The home page opens on a short silent loop of what Hivemind does that others do not: a
board of twenty agents across three projects; a person types one line to one of them, and that
agent builds a widget, installs it, puts it on the board and works through it, ticking it off. A
second, shorter clip, for the phone section, shows an agent asking before an edit and the person
answering on their phone. Every pixel of the app and the phone page is captured; nothing is
redrawn. One command makes both again.

**The rule it keeps.** `demo-scene-2026-09-18.md`: only real output from the real app. The
renderer moves a camera, a phone and a pointer over captured frames, writes a caption and lays a
quiet shader behind the window. It draws no interface, and it shows nothing the app cannot do:
the widget is installed with `hive widgets install`, because plugins do not load themselves.

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

- **Real Claude Code, twice.** `release-board` is the hero: it is typed one line and builds the
  widget, does issue FAS-1 and ticks the widget. `encoders-docs` raises a real permission prompt
  that the phone answers. Both run on the login of whoever records, with their settings, hooks,
  plugins, MCP servers and CLAUDE.md files kept out (`--setting-sources project,local`,
  `--strict-mcp-config`, `claudeMdExcludes`).
- **Stand-ins, eighteen.** The board behind them is eighteen tiles that print real command
  output on the real projects and the screen each agent's own manifest reads, so the status dot
  is the real detector's. They are stand-ins because the opening needs all of them working at the
  same moment, and at board zoom no line of theirs can be read.

## Pipeline

```
demo-workspace.sh   →  /tmp/hivemind-demo
capture.spec.ts     →  ~/hivemind-demo-recording/frames/*.png + cues.json   (once; real agents)
render/render.mjs   →  docs/public/shots/{hero,phone}/clip.webm, clip.mp4, poster.webp
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
   phone and pointer. Copy or timing changes never need a new recording.
4. **Render**: a Remotion composition (`render/src/Clip.tsx`) whose frame `f` is a pure function
   of story, cues and frames, behind it remocn's mesh-gradient shader (paper-design/shaders,
   Apache-2.0; the wrapper, MIT), clocked by the frame number. Frames go to ffmpeg once per
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
| entrances | 200–500 ms, ease-out; the hook within 2 s |

On the page the poster is an `<img fetchpriority="high">`; the `<video muted playsinline loop
preload="none">` over it starts after `load` and shows only once it plays. A Pause button is always
there. With `prefers-reduced-motion: reduce` the video does not start; the button can start it.

## Regenerating

```bash
cd apps/desktop && pnpm build                  # the app that is recorded
crates/hive-web/build.sh                       # the phone page (see tools.sh); hive-net built
node scripts/demo-media/demo-media.mjs          # workspace, recording, render
node scripts/demo-media/demo-media.mjs --render # render again from the recording kept
```

It refuses to render when the recording's scene is wrong (too few agents working, no widget, a
widget not ticked off, not exactly one agent waiting) and prints each output against its budget.
Remotion is used under its free licence (individuals and companies of up to three people).
