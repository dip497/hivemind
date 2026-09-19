# Streaming FPS: the cause was xterm 5's viewport

Status: **fixed and measured.** Upgrading xterm.js 5.5 → 6.0 removes the cost.

**Symptom:** the window drops frames while agents or shells stream output.

**Cause:** xterm 5.5's DOM `Viewport._innerRefresh` reads `offsetHeight`, writes the
scroll area's height, then reads and writes `scrollTop` on every render of every
terminal. Each read after a write forces a synchronous style-and-layout pass, and the
scroll changes also invalidate paint and compositing layers. xterm 6 replaced that
viewport with VS Code's scrollable element, which does none of it.

## Result

Three shells each printing a line every 20 ms. Real GPU (Intel UHD, Mesa, ANGLE)
through Xwayland, uncapped (see *Method*). Three interleaved runs per build, 24 samples
each, medians:

| streaming scene | xterm 5.5 | xterm 6.0 | frame p95 |
|---|---:|---:|---|
| default effects · idle | 51 fps | **956 fps** | 31.7 → **1.4 ms** |
| default effects · pan | 46 fps | **573 fps** | 32.5 → **5.9 ms** |
| effects off · idle | 47 fps | 62 fps | 36.6 → **17.0 ms** |
| effects off · pan | 43 fps | 65 fps | 36.9 → **17.2 ms** |

With animated effects the page produces frames continuously, so those rows measure
throughput: streaming frames went from about **2× the 16.7 ms budget to about 10% of
it**. With effects off, frames only happen on output, so FPS tracks the output rate;
there the point is the p95 falling to the frame interval, i.e. no over-budget frames.
Quiet scenes are unchanged within noise.

A timeline trace shows the mechanism directly. Same workload, 4 s:

| | xterm 5.5 | xterm 6.0 |
|---|---|---|
| JS-forced layout | **606 events, 649 ms** (16% of the main thread), every one in `_innerRefresh` | **1 event, 2 ms** |
| worst main-frame | 37.9 ms | 11.9 ms |
| worst single task | 65.7 ms | 35.9 ms |

A CPU profile of the same run puts hivemind's own code at about 2% of the main thread.
The rest was xterm and Blink's rendering pipeline — which is why nothing in the app's
own streaming path (IPC, status polling, the agent registry) was the problem.

## What the upgrade needed

- `windowsMode` removed from the terminal options (#5462; `false` was the default).
- **Alt+Left/Right word jumps preserved.** xterm 5 remapped them internally; xterm 6 dropped that (#5346) and leaves it to the embedder, so the key handler sends Ctrl+Arrow (ESC b / ESC f on macOS) itself.
- **Scrollbar kept at 6 px and themed.** It is VS Code's scrollbar now, sized inline (hence `!important`) and coloured from the terminal foreground via `scrollbarSlider*`; its hard-coded `#000` top shadow, which xterm 5 never had, is hidden.
- Verified unchanged rather than assumed: `.xterm-viewport` still exists (wheel routing only checks its presence), and the private `_mouseService.getCoords(e, el, cols, rows, sel)` / `getMouseReportCoords(e, el)` signatures the mouse patch wraps are the same.
- Also new in 6.0 and relevant here: synchronized output (DEC mode 2026, #5453), which agent TUIs use to batch redraws.

## The renderer policy was not the cause — measured twice now

> **Superseded 2026-09-19:** these runs measured frame *rate* while streaming —
> both columns far above a 60 Hz display, i.e. headroom nobody sees. The
> per-keystroke measurement in the next section reversed the conclusion; the
> DOM-when-focused rule is gone.

The selected terminal stays on the DOM renderer below 2x DPR while it streams. That
looks like the obvious culprit, and moving it to WebGL was tried on 2026-07-15 and
reverted because it "did not recover the frame rate". It was tried again during this
investigation, and on xterm 6 it is **slower** where it matters:

| streaming, default effects | selected tile DOM (kept) | selected tile WebGL |
|---|---|---|
| idle | **956 fps**, p95 1.4 ms | 506 fps, p95 8.7 ms |
| pan | **573 fps**, p95 5.9 ms | 429 fps, p95 9.8 ms |

The rule then lived in `terminal-renderer-policy.ts` as a pure function with tests
that cited these numbers, so the next attempt to "optimise" it failed a test first.

## 2026-09-19 — every visible terminal draws on the GPU

The table above measured frame rate while streaming. What users feel is the
per-keystroke cost of typing into a focused agent tile, which it never measured.
Per keystroke on the renderer main thread (A/B, same session, interleaved
DOM/WebGL/DOM/WebGL/DOM):

| typing into a focused Claude Code tile | renderer main thread |
|---|---:|
| DOM (the old rule below 2x DPR) | 14.4, 16.3, 15.8 ms |
| DOM once the input wraps over lines | 40–60 ms |
| WebGL | 6.1, 6.5 ms |

Claude redraws ~42 rows per keystroke; the DOM renderer rebuilds each row as spans
→ ~2–12 ms style + ~3–14 ms layout. Other Electron terminal apps default every
visible terminal to WebGL and use DOM only as a fallback; one measured DOM at
1.2x–13.7x more renderer CPU.

**Policy** (`terminal-renderer-policy.ts`): a terminal that holds a WebGL slot
renders with WebGL. DOM is only a fallback — (a) during a WebGL context-loss
cooldown, (b) when the slot manager has no slot for the tile (budget /
off-screen; off-screen tiles don't paint anyway). The "selected tile below 2x
DPR uses DOM" and "quiet tile switches to DOM" rules are removed: each
quiet↔streaming transition paid a full redraw plus a GL context create/destroy,
and the sharpness they bought is a loss exactly where typing happens.

## Method, and three traps

**1. A live desktop is not a benchmark.** On this GNOME/Mutter session, the capped
harness measured ~1 fps for any scene that changed pixels, in both builds, while a
16 ms `setInterval` in the page stayed on time (`lagP95` 0.1 ms) — the main thread was
idle and each *present* was waiting ~1 s for a vsync that did not arrive. It was
intermittent (one identical run read 60 fps) and survived forcing the window
always-on-top. A minimal Electron window through the same path presented at 60 fps,
and hivemind itself did too on one rerun with nothing changed. The cause was not
pinned down: it did not reproduce on demand, which points at desktop state rather
than the app, but that is an inference, not a finding. **Measure uncapped** — `--disable-gpu-vsync
--disable-frame-rate-limit` — which takes the compositor out of the loop and measures
rendering cost directly; it is also more sensitive to per-frame cost, which is what an
A/B compares.

**2. Check which display you are actually on.** After a reboot the session came up as
Wayland and `DISPLAY=:1` no longer existed; Electron silently fell through to native
Wayland. Record `XDG_SESSION_TYPE` with every result, the way the harness already
records the GPU backend.

**3. Interleave, and counterbalance.** Two builds run one after the other under
different load measured different machines. Runs were ordered ABBAAB (three builds:
ABCCABBCA) so drift lands on every build equally. One run failed its setup probe
(`No uncovered canvas pane`) and was retried; it is identical in every build and is a
race with where spawned tiles land.

**How the cause was found, for next time:** a CPU profile (`Profiler.start`) resolved
through the build's source maps with Node's built-in `module.SourceMap` gives
functions and files; `(program)` in a renderer profile is Blink's native work, not
idle. A timeline trace with `disabled-by-default-devtools.timeline.stack` attaches the
JS stack to every forced layout, which is what named `_innerRefresh` outright.

## An earlier version of this note was wrong

It blamed the renderer policy and three orphaned `context-mode` bun processes (about
2.3 cores at ~78% CPU for 14 hours). The orphans were real and worth killing, and
they made every earlier measurement noisy, but they were not the cause: the xterm 5
cost reproduces on a quiet machine and disappears with xterm 6 on the same machine.
